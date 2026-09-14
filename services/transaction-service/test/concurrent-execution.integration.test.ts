import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { envVars } from "../src/config/env.utils.js";
import { execute } from "../src/services/transaction.service.js";
import { closeLockRedis } from "../src/lib/recoveryLock.js";
import { startAccountMock, startLedgerMock } from "./helpers/mockServices.js";

// Proves the F-boundary: an original execute() racing a second concurrent
// execute() (recovery tick / manual recover) cannot interleave reversal
// (compensation) with forward progress (ledger batch + credit) in a way
// that creates money. Mutual exclusion lives inside execute() itself, so
// every entry path is serialized per transaction.
describe("concurrent execution (integration)", () => {
  let account: ReturnType<typeof startAccountMock>;
  let ledger: ReturnType<typeof startLedgerMock>;
  const sender = crypto.randomUUID();
  const recipient = crypto.randomUUID();
  const AMOUNT = 10_000;

  const seedStuckTx = async () => {
    const txid = crypto.randomUUID();
    const key = `concurrent-${txid}`;
    await prisma.idempotencyKey.create({
      data: { key, requestHash: "seed-hash", transactionId: txid },
    });
    const row = await prisma.transaction.create({
      data: {
        id: txid,
        idempotencyKey: key,
        requestHash: "seed-hash",
        senderWalletId: sender,
        recipientWalletId: recipient,
        amountCents: BigInt(AMOUNT),
        currency: "USD",
        status: "PROCESSING",
        processingStartedAt: new Date(Date.now() - 120_000),
      },
    });
    return row;
  };

  const balances = () => ({
    sender: account.state.balances.get(sender) ?? 0,
    recipient: account.state.balances.get(recipient) ?? 0,
  });

  const opCount = (suffix: string) =>
    account.state.appliedOps.filter((op) => op.endsWith(suffix)).length;

  const waitFor = async (cond: () => boolean, what: string) => {
    const deadline = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    await prisma.transaction.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    account = startAccountMock();
    ledger = startLedgerMock();
    await Promise.all([account.start(), ledger.start()]);
    envVars.ACCOUNT_SERVICE_URL = account.url();
    envVars.LEDGER_SERVICE_URL = ledger.url();
  });

  afterAll(async () => {
    await Promise.all([account.close(), ledger.close()]);
    await closeLockRedis();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    account.state.balances.clear();
    account.state.appliedOps.length = 0;
    account.state.gate = undefined;
    account.state.gateSuffix = undefined;
    ledger.state.batches.clear();
    ledger.state.failBatches = false;
    ledger.state.failNextBatches = 0;
    account.state.balances.set(sender, 100_000);
  });

  afterEach(async () => {
    await prisma.transaction.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
  });

  it("a recovery racing a failing original cannot create money", async () => {
    const row = await seedStuckTx();

    // A: the "original" — its ledger batch POST fails, so it will post a
    // reversal. Its reversal POST is gated so the race window stays open.
    ledger.state.failNextBatches = 1;
    let releaseReversal!: () => void;
    const reversalGate = new Promise<void>((r) => (releaseReversal = r));
    account.state.gateSuffix = ":reversal";
    account.state.gate = { promise: reversalGate, reached: false };

    const a = execute(row as any);
    // A debits, fails the ledger batch, and is now parked at the reversal.
    await waitFor(
      () => opCount(":debit") === 1 && (account.state.gate?.reached ?? false),
      "A parked at reversal",
    );

    // B: the "recovery" — runs while A is parked. Its reversal check sees
    // no reversal yet, so without mutual exclusion it would proceed to
    // ledger + credit while A reverses underneath it.
    const bResult = await execute(row as any);

    // B must NOT have performed any side effect: it reports fresh state.
    expect(bResult).toEqual({ transactionId: row.id, status: "PROCESSING" });
    expect(opCount(":credit")).toBe(0);
    expect(ledger.state.batches.has(row.id)).toBe(false);

    // Let A finish its reversal path.
    releaseReversal();
    await expect(a).rejects.toThrow();

    // Final database state: REVERSED, sender whole, recipient untouched,
    // no ledger batch, no duplicate operations. No money created.
    const tx = await prisma.transaction.findUnique({ where: { id: row.id } });
    expect(tx?.status).toBe("REVERSED");
    expect(balances()).toEqual({ sender: 100_000, recipient: 0 });
    expect(opCount(":debit")).toBe(1);
    expect(opCount(":reversal")).toBe(1);
    expect(opCount(":credit")).toBe(0);
    expect(ledger.state.batches.has(row.id)).toBe(false);

    // A later recovery is a safe no-op on the terminal state.
    const again = await execute(row as any);
    expect(again).toEqual({ transactionId: row.id, status: "REVERSED" });
    expect(balances()).toEqual({ sender: 100_000, recipient: 0 });
  });

  it("two concurrent recoveries perform the movement exactly once", async () => {
    const row = await seedStuckTx();
    const [r1, r2] = await Promise.all([
      execute(row as any),
      execute(row as any),
    ]);
    // Exactly one executor runs; the contender reports fresh state without
    // side effects. Emulate the next scheduler tick for the contender.
    for (const r of [r1, r2]) {
      expect(r.transactionId).toBe(row.id);
      if ((r as any).status !== "COMPLETED") {
        const retry = await execute(row as any);
        expect(retry).toEqual({ transactionId: row.id, status: "COMPLETED" });
      }
    }

    const tx = await prisma.transaction.findUnique({ where: { id: row.id } });
    expect(tx?.status).toBe("COMPLETED");
    expect(balances()).toEqual({
      sender: 100_000 - AMOUNT,
      recipient: AMOUNT,
    });
    expect(opCount(":debit")).toBe(1);
    expect(opCount(":credit")).toBe(1);
    expect(ledger.state.batches.has(row.id)).toBe(true);
  });
});
