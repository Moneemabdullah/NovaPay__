import { Prisma, Transaction } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { envVars } from "../config/env.utils.js";
import { setContext } from "../lib/context.js";
import { post, cents, sha, canonical } from "../lib/http.js";

export async function execute(tx: Transaction, id?: string) {
  const existing = await fetch(
    `${envVars.LEDGER_SERVICE_URL}/batches/${tx.id}`,
  ).then((r) => (r.ok ? r.json() : null));
  const destination = tx.destinationAmountCents ?? tx.amountCents;
  const currency = tx.destinationCurrency ?? tx.currency;
  if (!existing) {
    await post(
      envVars.ACCOUNT_SERVICE_URL,
      `/wallets/${tx.senderWalletId}/operations`,
      {
        operationKey: `${tx.id}:debit`,
        deltaCents: -Number(tx.amountCents),
      },
      id,
    );
    try {
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
      await post(envVars.LEDGER_SERVICE_URL, "/batches", { transactionId: tx.id, entries }, id);
    } catch (e) {
      await post(
        envVars.ACCOUNT_SERVICE_URL,
        `/wallets/${tx.senderWalletId}/operations`,
        {
          operationKey: `${tx.id}:reversal`,
          deltaCents: Number(tx.amountCents),
        },
        id,
      );
      throw e;
    }
  }
  await post(
    envVars.ACCOUNT_SERVICE_URL,
    `/wallets/${tx.recipientWalletId}/operations`,
    { operationKey: `${tx.id}:credit`, deltaCents: Number(destination) },
    id,
  );
  const body = { transactionId: tx.id, status: "COMPLETED" };
  await prisma.$transaction([
    prisma.transaction.update({
      where: { id: tx.id },
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
