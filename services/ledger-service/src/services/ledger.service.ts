import crypto from "node:crypto";
import { type LedgerEntry, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type LedgerEntryInput = {
  accountId: string;
  direction: "debit" | "credit";
  amountCents: number;
  currency: string;
  fxRate?: string;
};

export let violations = 0;

type HashableEntry = {
  accountId: string;
  direction: string;
  amountCents: bigint | number;
  currency: string;
};

export function hash(
  previous: string | null,
  entry: HashableEntry,
  timestamp: string,
) {
  return crypto
    .createHash("sha256")
    .update(
      `${previous ?? ""}|${entry.accountId}|${entry.direction}|${entry.amountCents}|${entry.currency}|${timestamp}`,
    )
    .digest("hex");
}

export function validateBatch(
  transactionId: string | undefined,
  entries: LedgerEntryInput[],
):
  | { status: 400; error: "VALIDATION_ERROR"; message: string }
  | { status: 422; error: "UNBALANCED_LEDGER_TRANSACTION"; message: string }
  | null {
  if (
    !transactionId ||
    entries.length < 2 ||
    entries.some(
      (e) =>
        !e.accountId ||
        !["debit", "credit"].includes(e.direction) ||
        !Number.isSafeInteger(e.amountCents) ||
        e.amountCents <= 0 ||
        !/^[A-Z]{3}$/.test(e.currency),
    )
  )
    return {
      status: 400,
      error: "VALIDATION_ERROR",
      message: "Valid transaction and entries required",
    };
  const totals = new Map<string, { d: number; c: number }>();
  for (const e of entries) {
    const x = totals.get(e.currency) ?? { d: 0, c: 0 };
    e.direction === "debit" ? (x.d += e.amountCents) : (x.c += e.amountCents);
    totals.set(e.currency, x);
  }
  if ([...totals.values()].some((x) => x.d !== x.c || !x.d || !x.c))
    return {
      status: 422,
      error: "UNBALANCED_LEDGER_TRANSACTION",
      message: "Debits must equal credits per currency",
    };
  return null;
}

export async function createBatch(input: {
  transactionId: string;
  entries: LedgerEntryInput[];
}) {
  return prisma.$transaction(async (tx) => {
    const replay = await tx.ledgerTransaction.findUnique({
      where: { transactionId: input.transactionId },
    });
    if (replay) return { ledgerTransactionId: replay.id, replayed: true };
    const transaction = await tx.ledgerTransaction.create({
      data: { transactionId: input.transactionId },
    });
    const last = await tx.ledgerEntry.findFirst({ orderBy: { id: "desc" } });
    let previous = last?.entryHash ?? null;
    for (const entry of input.entries) {
      const timestamp = new Date().toISOString();
      const entryHash = hash(previous, entry, timestamp);
      await tx.ledgerEntry.create({
        data: {
          ledgerTransactionId: transaction.id,
          accountId: entry.accountId,
          direction: entry.direction,
          amountCents: BigInt(entry.amountCents),
          currency: entry.currency,
          fxRate: entry.fxRate ? new Prisma.Decimal(entry.fxRate) : undefined,
          prevHash: previous,
          entryHash,
          createdAt: new Date(timestamp),
        },
      });
      previous = entryHash;
    }
    return { ledgerTransactionId: transaction.id };
  });
}

export function getBatch(transactionId: string) {
  return prisma.ledgerTransaction.findUnique({ where: { transactionId } });
}

export async function invariantCheck() {
  const rows = await prisma.$queryRaw<{ currency: string; delta: bigint }[]>(
    Prisma.sql`SELECT currency,COALESCE(SUM(CASE WHEN direction='debit' THEN amount_cents ELSE -amount_cents END),0) delta FROM ledger_entries GROUP BY currency`,
  );
  const ok = rows.every((x) => x.delta === 0n);
  if (!ok) violations++;
  return {
    delta: rows.reduce((v, x) => v + Number(x.delta), 0),
    ok,
    byCurrency: rows,
  };
}

export async function auditVerify() {
  const xs = await prisma.ledgerEntry.findMany({ orderBy: { id: "asc" } });
  let previous: string | null = null;
  for (const [i, x] of xs.entries()) {
    if (
      x.prevHash !== previous ||
      x.entryHash !== hash(previous, x, x.createdAt.toISOString())
    )
      return { ok: false, failedAt: i + 1 };
    previous = x.entryHash;
  }
  return { ok: true, records: xs.length };
}
