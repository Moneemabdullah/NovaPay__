import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { envVars } from "../src/config/env.utils.js";
import { startAccountMock, startLedgerMock } from "./helpers/mockServices.js";

const AMOUNT = 10_000;

describe("crash recovery (integration)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let account: ReturnType<typeof startAccountMock>;
  let ledger: ReturnType<typeof startLedgerMock>;
  const sender = crypto.randomUUID();
  const recipient = crypto.randomUUID();

  const seedTx = async (txid: string, key: string) => {
    await prisma.idempotencyKey.create({
      data: { key, requestHash: "seed-hash", transactionId: txid },
    });
    await prisma.transaction.create({
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
  };

  const applyOp = (walletId: string, operationKey: string, deltaCents: number) =>
    fetch(`${account.url()}/wallets/${walletId}/operations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationKey, deltaCents }),
    });

  const postBalancedBatch = (txid: string) =>
    fetch(`${ledger.url()}/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transactionId: txid,
        entries: [
          {
            accountId: sender,
            direction: "debit",
            amountCents: AMOUNT,
            currency: "USD",
          },
          {
            accountId: recipient,
            direction: "credit",
            amountCents: AMOUNT,
            currency: "USD",
          },
        ],
      }),
    });

  const recover = () =>
    app.inject({ method: "POST", url: "/internal/recover" });

  const isBalancedBatch = (batch: { entries: { direction: string; amountCents: number }[] } | undefined) => {
    if (!batch || batch.entries.length !== 2) return false;
    const totals = batch.entries.reduce(
      (acc, e) => {
        acc[e.direction] += e.amountCents;
        return acc;
      },
      { debit: 0, credit: 0 },
    );
    return totals.debit === totals.credit;
  };

  const senderBalance = () => account.state.balances.get(sender) ?? 0;
  const recipientBalance = () => account.state.balances.get(recipient) ?? 0;
  const countOf = (suffix: string) =>
    account.state.appliedOps.filter((op) => op.endsWith(suffix)).length;

  beforeAll(async () => {
    await prisma.transaction.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    account = startAccountMock();
    ledger = startLedgerMock();
    await Promise.all([account.start(), ledger.start()]);
    envVars.ACCOUNT_SERVICE_URL = account.url();
    envVars.LEDGER_SERVICE_URL = ledger.url();
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([account.close(), ledger.close()]);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    account.state.balances.clear();
    account.state.appliedOps.length = 0;
    ledger.state.batches.clear();
    ledger.state.failBatches = false;
    account.state.balances.set(sender, 100_000);
  });

  afterEach(async () => {
    await prisma.transaction.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
  });

  it("Test 1: debit succeeds -> ledger fails -> reversal succeeds; the transaction is REVERSED and the recipient receives nothing", async () => {
    const key = `ledger-fail-${crypto.randomUUID()}`;

    ledger.state.failBatches = true;
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: { "idempotency-key": key },
      payload: {
        senderWalletId: sender,
        recipientWalletId: recipient,
        amountCents: AMOUNT,
        currency: "USD",
      },
    });
    expect(res.statusCode).toBe(500);

    const tx = await prisma.transaction.findUnique({
      where: { idempotencyKey: key },
    });
    expect(tx?.status).toBe("REVERSED");
    expect(account.state.appliedOps).toContain(`${tx!.id}:debit`);
    expect(account.state.appliedOps).toContain(`${tx!.id}:reversal`);
    // Money was not created and the movement aborted: sender is net-zero,
    // recipient got nothing, no ledger batch exists.
    expect(senderBalance()).toBe(100_000);
    expect(recipientBalance()).toBe(0);
    expect(ledger.state.batches.get(tx!.id)).toBeUndefined();

    // Recovery sees a terminal state and is a no-op.
    const rec = await recover();
    expect(rec.statusCode).toBe(200);
    expect(rec.json()).toEqual({ recovered: 0 });
    const after = await prisma.transaction.findUnique({ where: { id: tx!.id } });
    expect(after?.status).toBe("REVERSED");
    expect(recipientBalance()).toBe(0);
  });

  it("Test 1b: crash between the reversal being applied and the status being persisted still resolves to REVERSED (never recreates money)", async () => {
    const txid = crypto.randomUUID();
    const key = `reversal-window-${txid}`;
    await seedTx(txid, key);

    // The first attempt got to: debit applied, ledger failed, reversal
    // applied, then crashed before flipping the transaction's status.
    await applyOp(sender, `${txid}:debit`, -AMOUNT);
    await applyOp(sender, `${txid}:reversal`, AMOUNT);
    expect(senderBalance()).toBe(100_000);

    const rec = await recover();
    expect(rec.statusCode).toBe(200);
    expect(rec.json()).toEqual({ recovered: 1 });

    const tx = await prisma.transaction.findUnique({ where: { id: txid } });
    expect(tx?.status).toBe("REVERSED");
    // The reversed debit must never be replayed as a live debit: no ledger
    // batch, no recipient credit.
    expect(ledger.state.batches.get(txid)).toBeUndefined();
    expect(recipientBalance()).toBe(0);
    expect(countOf(":credit")).toBe(0);
    // Total wallet movement for the whole sequence stays zero.
    expect(senderBalance()).toBe(100_000);

    // Second recovery is a no-op with the same terminal state.
    const second = await recover();
    expect(second.json()).toEqual({ recovered: 0 });
    expect(recipientBalance()).toBe(0);
    expect(senderBalance()).toBe(100_000);
  });

  it("Test 2: debit + ledger succeeded, crash before the final status update; recovery completes without double debit or credit", async () => {
    const txid = crypto.randomUUID();
    const key = `crash-after-ledger-${txid}`;
    await seedTx(txid, key);

    // The movement is committed: debit applied and the balanced ledger batch
    // exists. The credit was already applied before the crash, i.e. only the
    // final COMPLETED status write was lost.
    await applyOp(sender, `${txid}:debit`, -AMOUNT);
    await postBalancedBatch(txid);
    await applyOp(recipient, `${txid}:credit`, AMOUNT);

    const res = await recover();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: 1 });

    const tx = await prisma.transaction.findUnique({ where: { id: txid } });
    expect(tx?.status).toBe("COMPLETED");
    expect(senderBalance()).toBe(100_000 - AMOUNT);
    expect(recipientBalance()).toBe(AMOUNT);
    expect(countOf(":debit")).toBe(1);
    expect(countOf(":credit")).toBe(1);
    expect(ledger.state.batches.get(txid)).toBeDefined();

    const second = await recover();
    expect(second.json()).toEqual({ recovered: 0 });
    expect(senderBalance()).toBe(100_000 - AMOUNT);
    expect(recipientBalance()).toBe(AMOUNT);
  });

  it("Test 2b: crash after the batch but before the credit; recovery credits the recipient exactly once", async () => {
    const txid = crypto.randomUUID();
    const key = `crash-before-credit-${txid}`;
    await seedTx(txid, key);

    await applyOp(sender, `${txid}:debit`, -AMOUNT);
    await postBalancedBatch(txid);
    expect(recipientBalance()).toBe(0);

    const res = await recover();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: 1 });

    const tx = await prisma.transaction.findUnique({ where: { id: txid } });
    expect(tx?.status).toBe("COMPLETED");
    expect(senderBalance()).toBe(100_000 - AMOUNT);
    expect(recipientBalance()).toBe(AMOUNT);
    expect(countOf(":debit")).toBe(1);
    expect(countOf(":credit")).toBe(1);
  });

  it("Test 3/4: successful recovery debits and credits exactly once, has one balanced batch, and a second recovery is a no-op", async () => {
    const txid = crypto.randomUUID();
    const key = `crash-after-debit-${txid}`;
    await seedTx(txid, key);

    // Crash after the debit was applied but before the ledger batch ran.
    await applyOp(sender, `${txid}:debit`, -AMOUNT);

    const res = await recover();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ recovered: 1 });

    const tx = await prisma.transaction.findUnique({ where: { id: txid } });
    expect(tx?.status).toBe("COMPLETED");
    expect(senderBalance()).toBe(100_000 - AMOUNT);
    expect(recipientBalance()).toBe(AMOUNT);
    expect(countOf(":debit")).toBe(1);

    const batch = ledger.state.batches.get(txid);
    expect(isBalancedBatch(batch)).toBe(true);

    const second = await recover();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ recovered: 0 });
    expect(senderBalance()).toBe(100_000 - AMOUNT);
    expect(recipientBalance()).toBe(AMOUNT);
  });

  it("Test 5: ledger batches only exist for really-debited movements and are always balanced (ledger invariant holds at the boundary)", async () => {
    // Scenario set that exercises every execution path: one completed movement
    // and one fully reversed movement.
    const done = crypto.randomUUID();
    const doneKey = `invariant-complete-${done}`;
    await seedTx(done, doneKey);
    await applyOp(sender, `${done}:debit`, -AMOUNT);
    await recover();
    expect(ledger.state.batches.has(done)).toBe(true);
    expect(isBalancedBatch(ledger.state.batches.get(done))).toBe(true);
    // Constraint 1: a batch exists only together with a real account debit.
    expect(countOf(":debit")).toBe(1);

    const reverted = crypto.randomUUID();
    const revertedKey = `invariant-reversed-${reverted}`;
    await seedTx(reverted, revertedKey);
    await applyOp(sender, `${reverted}:debit`, -AMOUNT);
    await applyOp(sender, `${reverted}:reversal`, AMOUNT);
    await recover();
    // The reversed movement left no trace in the ledger.
    expect(ledger.state.batches.has(reverted)).toBe(false);

    // Aggregate ledger delta across every scenario batch is zero.
    let debitTotal = 0;
    let creditTotal = 0;
    for (const b of ledger.state.batches.values()) {
      for (const e of b.entries) {
        e.direction === "debit"
          ? (debitTotal += e.amountCents)
          : (creditTotal += e.amountCents);
      }
    }
    expect(debitTotal).toBe(creditTotal);
  });
});