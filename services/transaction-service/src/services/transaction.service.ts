import { Prisma, Transaction } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { envVars } from "../config/env.utils.js";
import { setContext } from "../lib/context.js";
import { post, cents, sha, canonical, get } from "../lib/http.js";
import { getTracer } from "../lib/otel.js";
import { SpanStatusCode } from "@opentelemetry/api";

export async function execute(tx: Transaction, id?: string) {
  const tracer = getTracer();
  return tracer.startActiveSpan("transaction.execute", async (span) => {
    try {
      span.setAttribute("transaction.id", tx.id);
      span.setAttribute("transaction.currency", tx.currency);
      span.setAttribute("transaction.amount_cents", Number(tx.amountCents));
  const current = await prisma.transaction.findUnique({
    where: { id: tx.id },
    select: { status: true },
  });
  if (
    current &&
    current.status !== "PROCESSING" &&
    current.status !== "PENDING"
  ) {
    if (current.status === "COMPLETED") {
      const key = await prisma.idempotencyKey.findUnique({
        where: { key: tx.idempotencyKey },
      });
      span.setAttribute("transaction.replay", true);
      span.end();
      return (
        key?.responseBody ?? { transactionId: tx.id, status: "COMPLETED" }
      );
    }
    span.setAttribute("transaction.terminal_status", current.status);
    span.end();
    return { transactionId: tx.id, status: current.status };
  }
  const destination = tx.destinationAmountCents ?? tx.amountCents;
  const currency = tx.destinationCurrency ?? tx.currency;
  const reversalKey = `${tx.id}:reversal`;
  const creditKey = `${tx.id}:credit`;

  let reversalApplied: boolean;
  try {
    reversalApplied =
      (await get(
        envVars.ACCOUNT_SERVICE_URL,
        `/wallets/${tx.senderWalletId}/operations/${encodeURIComponent(reversalKey)}`,
        id,
      )) !== null;
  } catch (e: any) {
    span.recordException(e);
    span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
    span.end();
    throw Object.assign(
      new Error("Cannot reconcile sender debit state with the account"),
      {
        status: 503,
        code: "ACCOUNT_RECONCILIATION_UNAVAILABLE",
        cause: e,
      },
    );
  }

  const existing = await get(
    envVars.LEDGER_SERVICE_URL,
    `/batches/${tx.id}`,
    id,
  );

  if (reversalApplied) {
    span.setAttribute("transaction.outcome", "reversed");
    await prisma.transaction.updateMany({
      where: { id: tx.id, status: "PROCESSING" },
      data: {
        status: "REVERSED",
        failureReason: "Sender debit reversed; transfer aborted",
      },
    });
    span.end();
    return { transactionId: tx.id, status: "REVERSED" };
  }

  if (existing) {
    span.setAttribute("transaction.outcome", "completed_from_batch");
    await post(
      envVars.ACCOUNT_SERVICE_URL,
      `/wallets/${tx.recipientWalletId}/operations`,
      { operationKey: creditKey, deltaCents: Number(destination) },
      id,
    );
    const body = { transactionId: tx.id, status: "COMPLETED" };
    await prisma.$transaction([
      prisma.transaction.updateMany({
        where: { id: tx.id, status: "PROCESSING" },
        data: { status: "COMPLETED", completedAt: new Date() },
      }),
      prisma.idempotencyKey.update({
        where: { key: tx.idempotencyKey },
        data: { status: "completed", responseBody: body },
      }),
    ]);
    span.end();
    return body;
  }

  const entries = tx.destinationCurrency
    ? [
        {
          accountId: tx.senderWalletId,
          direction: "debit",
          amountCents: Number(tx.amountCents),
          currency: tx.currency,
          fxRate: tx.fxRate?.toString(),
        },
        {
          accountId: "00000000-0000-0000-0000-000000000001",
          direction: "credit",
          amountCents: Number(tx.amountCents),
          currency: tx.currency,
          fxRate: tx.fxRate?.toString(),
        },
        {
          accountId: "00000000-0000-0000-0000-000000000001",
          direction: "debit",
          amountCents: Number(destination),
          currency,
          fxRate: tx.fxRate?.toString(),
        },
        {
          accountId: tx.recipientWalletId,
          direction: "credit",
          amountCents: Number(destination),
          currency,
          fxRate: tx.fxRate?.toString(),
        },
      ]
    : [
        {
          accountId: tx.senderWalletId,
          direction: "debit",
          amountCents: Number(tx.amountCents),
          currency: tx.currency,
        },
        {
          accountId: tx.recipientWalletId,
          direction: "credit",
          amountCents: Number(tx.amountCents),
          currency: tx.currency,
        },
      ];

  await tracer.startActiveSpan("debit.sender", async (debitSpan) => {
    try {
      await post(
        envVars.ACCOUNT_SERVICE_URL,
        `/wallets/${tx.senderWalletId}/operations`,
        { operationKey: `${tx.id}:debit`, deltaCents: -Number(tx.amountCents) },
        id,
      );
      debitSpan.end();
    } catch (e) {
      debitSpan.recordException(e as Error);
      debitSpan.setStatus({ code: SpanStatusCode.ERROR });
      debitSpan.end();
      throw e;
    }
  });

  try {
    await tracer.startActiveSpan("ledger.createBatch", async (ledgerSpan) => {
      try {
        await post(envVars.LEDGER_SERVICE_URL, "/batches", { transactionId: tx.id, entries }, id);
        ledgerSpan.end();
      } catch (e) {
        ledgerSpan.recordException(e as Error);
        ledgerSpan.setStatus({ code: SpanStatusCode.ERROR });
        ledgerSpan.end();
        throw e;
      }
    });
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as any).message });
    await post(
      envVars.ACCOUNT_SERVICE_URL,
      `/wallets/${tx.senderWalletId}/operations`,
      { operationKey: reversalKey, deltaCents: Number(tx.amountCents) },
      id,
    );
    await prisma.transaction.updateMany({
      where: { id: tx.id, status: "PROCESSING" },
      data: { status: "REVERSED", failureReason: (e as any).code ?? (e as any).message },
    });
    span.setAttribute("transaction.outcome", "reversed_after_ledger_failure");
    span.end();
    throw e;
  }

  await tracer.startActiveSpan("credit.recipient", async (creditSpan) => {
    try {
      await post(
        envVars.ACCOUNT_SERVICE_URL,
        `/wallets/${tx.recipientWalletId}/operations`,
        { operationKey: creditKey, deltaCents: Number(destination) },
        id,
      );
      creditSpan.end();
    } catch (e) {
      creditSpan.recordException(e as Error);
      creditSpan.setStatus({ code: SpanStatusCode.ERROR });
      creditSpan.end();
      throw e;
    }
  });

  const body = { transactionId: tx.id, status: "COMPLETED" };
  await prisma.$transaction([
    prisma.transaction.updateMany({
      where: { id: tx.id, status: "PROCESSING" },
      data: { status: "COMPLETED", completedAt: new Date() },
    }),
    prisma.idempotencyKey.update({
      where: { key: tx.idempotencyKey },
      data: { status: "completed", responseBody: body },
    }),
  ]);
  span.setAttribute("transaction.outcome", "completed");
  span.end();
  return body;
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      span.end();
      throw e;
    }
  });
}

export async function initiate(
  q: any,
  r: any,
  international = false,
): Promise<any> {
  const tracer = getTracer();
  return tracer.startActiveSpan("transaction.initiate", async (span) => {
    try {
  const key = q.headers["idempotency-key"] as string | undefined;
  const p = q.body as any;
  const amount = international ? p.sourceAmountCents : p.amountCents;
  const currency = international ? p.sourceCurrency : p.currency;
  span.setAttribute("transaction.type", international ? "international" : "domestic");
  span.setAttribute("transaction.currency", currency ?? "unknown");
  if (!key)
    return fail(
      r,
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required",
    );
  if (
    !p.senderWalletId ||
    !p.recipientWalletId ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !/^[A-Z]{3}$/.test(currency ?? "")
  )
    return fail(
      r,
      400,
      "VALIDATION_ERROR",
      "Valid wallet IDs, currency and positive integer cents required",
    );
  const requestHash = sha(p);
  let tx: Transaction;
  try {
    tx = await prisma.$transaction(async (db) => {
      await db.idempotencyKey.create({ data: { key, requestHash } });
      const x = await db.transaction.create({
        data: {
          idempotencyKey: key,
          requestHash,
          senderWalletId: p.senderWalletId,
          recipientWalletId: p.recipientWalletId,
          amountCents: BigInt(amount),
          currency,
          status: "PROCESSING",
          processingStartedAt: new Date(),
          fxQuoteId: international ? p.quoteId : undefined,
        },
      });
      await db.idempotencyKey.update({
        where: { key },
        data: { transactionId: x.id },
      });
      return x;
    });
    span.setAttribute("transaction.id", tx.id);
    setContext({ transactionId: tx.id });
  } catch (e: any) {
    if (e.code !== "P2002") throw e;
    const old = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (!old) return fail(r, 409, "IDEMPOTENCY_RACE", "Retry request");
    if (old.expiresAt < new Date())
      return fail(
        r,
        409,
        "IDEMPOTENCY_KEY_EXPIRED",
        "Verify original transaction before using a new key",
      );
    if (old.requestHash !== requestHash)
      return fail(
        r,
        409,
        "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
        "This idempotency key was already used with a different request payload.",
      );
    span.setAttribute("transaction.replay", true);
    span.end();
    return old.status === "completed"
      ? old.responseBody
      : r
          .code(202)
          .send({ transactionId: old.transactionId, status: "PROCESSING" });
  }
  if (international) {
    try {
      span.setAttribute("fx.quote_id", p.quoteId);
      const quote = await post(
        envVars.FX_SERVICE_URL,
        `/quote/${p.quoteId}/consume`,
        { transactionId: tx.id },
        q.headers["x-request-id"],
      );
      span.setAttribute("fx.rate", String(quote.rate));
      if (
        quote.baseCurrency !== p.sourceCurrency ||
        quote.quoteCurrency !== p.destinationCurrency
      )
        return fail(
          r,
          422,
          "FX_QUOTE_CURRENCY_MISMATCH",
          "Quote does not match currencies",
        );
      tx = await prisma.transaction.update({
        where: { id: tx.id },
        data: {
          destinationAmountCents: BigInt(
            cents(BigInt(amount), String(quote.rate)),
          ),
          destinationCurrency: p.destinationCurrency,
          fxRate: new Prisma.Decimal(quote.rate),
        },
      });
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { status: "FAILED", failureReason: e.code ?? e.message },
      });
      span.end();
      return fail(
        r,
        e.status ?? 503,
        e.code ?? "FX_PROVIDER_UNAVAILABLE",
        e.message,
      );
    }
  }
  const result = await execute(tx, q.headers["x-request-id"]);
  span.end();
  return r.code(201).send(result);
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      span.end();
      throw e;
    }
  });
}

function fail(r: any, s: number, error: string, message: string) {
  return r.code(s).send({
    error,
    message,
    requestId: r.request.headers["x-request-id"] ?? null,
  });
}
