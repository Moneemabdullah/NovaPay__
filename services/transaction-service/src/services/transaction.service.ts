import { Prisma, Transaction } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { envVars } from "../config/env.utils.js";
import { setContext } from "../lib/context.js";
import { post, cents, sha, canonical, get } from "../lib/http.js";

export async function execute(tx: Transaction, id?: string) {
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
      return (
        key?.responseBody ?? { transactionId: tx.id, status: "COMPLETED" }
      );
    }
    return { transactionId: tx.id, status: current.status };
  }
  const destination = tx.destinationAmountCents ?? tx.amountCents;
  const currency = tx.destinationCurrency ?? tx.currency;
  const reversalKey = `${tx.id}:reversal`;
  const creditKey = `${tx.id}:credit`;

  // Reconcile against the account: was the sender debit reversed? The account
  // is the durable source of truth for wallet operations (`walletBalanceOperation`),
  // so this is safe across a crash between the reversal being applied and this
  // flow persisting the terminal status. A reversed debit must never be treated
  // as a live, existing debit again.
  let reversalApplied: boolean;
  try {
    reversalApplied =
      (await get(
        envVars.ACCOUNT_SERVICE_URL,
        `/wallets/${tx.senderWalletId}/operations/${encodeURIComponent(reversalKey)}`,
        id,
      )) !== null;
  } catch (e: any) {
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
    await prisma.transaction.updateMany({
      where: { id: tx.id, status: "PROCESSING" },
      data: {
        status: "REVERSED",
        failureReason: "Sender debit reversed; transfer aborted",
      },
    });
    return { transactionId: tx.id, status: "REVERSED" };
  }

  if (existing) {
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
  await post(
    envVars.ACCOUNT_SERVICE_URL,
    `/wallets/${tx.senderWalletId}/operations`,
    { operationKey: `${tx.id}:debit`, deltaCents: -Number(tx.amountCents) },
    id,
  );
  try {
    await post(envVars.LEDGER_SERVICE_URL, "/batches", { transactionId: tx.id, entries }, id);
  } catch (e) {
    // Reversing is idempotent (`{id}:reversal`). Even if this POST is lost
    // mid-flight, the account commits it and a later recovery observes it via
    // the operation lookup above — the debit can never be replayed as live,
    // so no batch is ever created and no credit is ever issued for it.
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
    throw e;
  }
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
  return body;
}

export async function initiate(
  q: any,
  r: any,
  international = false,
): Promise<any> {
  const key = q.headers["idempotency-key"] as string | undefined;
  const p = q.body as any;
  const amount = international ? p.sourceAmountCents : p.amountCents;
  const currency = international ? p.sourceCurrency : p.currency;
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
    return old.status === "completed"
      ? old.responseBody
      : r
          .code(202)
          .send({ transactionId: old.transactionId, status: "PROCESSING" });
  }
  if (international) {
    try {
      const quote = await post(
        envVars.FX_SERVICE_URL,
        `/quote/${p.quoteId}/consume`,
        { transactionId: tx.id },
        q.headers["x-request-id"],
      );
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
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { status: "FAILED", failureReason: e.code ?? e.message },
      });
      return fail(
        r,
        e.status ?? 503,
        e.code ?? "FX_PROVIDER_UNAVAILABLE",
        e.message,
      );
    }
  }
  return r.code(201).send(await execute(tx, q.headers["x-request-id"]));
}

function fail(r: any, s: number, error: string, message: string) {
  return r.code(s).send({
    error,
    message,
    requestId: r.request.headers["x-request-id"] ?? null,
  });
}
