import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { envVars } from "../src/config/env.utils.js";
import { processPayroll } from "../src/services/payroll.service.js";
import { startTransactionMock } from "./helpers/mockTransactionService.js";

const BATCH_SIZE = Number(process.env.PAYROLL_BATCH_SIZE ?? "500");
const CRASH_AT = BATCH_SIZE === 1 ? 0 : Math.floor(BATCH_SIZE / 2);

const itemKey = (jobId: string, i: number) =>
  crypto.createHash("sha256").update(`${jobId}:${i}`).digest("hex");

describe("payroll resumability (integration)", () => {
  let txMock: ReturnType<typeof startTransactionMock>;
  const employerId = crypto.randomUUID();

  beforeAll(async () => {
    txMock = startTransactionMock();
    await txMock.start();
    envVars.TRANSACTION_SERVICE_URL = txMock.url();
  });

  afterAll(async () => {
    await txMock.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.payrollItem.deleteMany({});
    await prisma.payrollJob.deleteMany({});
  });

  it(`resumes after a mid-batch crash (${BATCH_SIZE} items, crash at ${CRASH_AT}); no item is lost or double-paid`, async () => {
    const job = await prisma.payrollJob.create({
      data: { employerAccountId: employerId, totalItems: BATCH_SIZE },
    });
    await prisma.payrollItem.createMany({
      data: Array.from({ length: BATCH_SIZE }, (_, i) => ({
        jobId: job.id,
        lineIndex: i,
        recipientWalletId: crypto.randomUUID(),
        amountCents: BigInt(100 + i),
        // Same deterministic derivation as createPayrollJob in payroll.service.ts
        idempotencyKey: itemKey(job.id, i),
      })),
    });

    // Crash point: the mock transaction service rejects exactly the item at
    // CRASH_AT, so processPayroll throws mid-batch, as a worker would.
    txMock.state.failKey = itemKey(job.id, CRASH_AT);
    await expect(processPayroll(job.id)).rejects.toThrow();

    const afterCrash = await prisma.payrollJob.findUnique({
      where: { id: job.id },
    });
    expect(afterCrash?.status).toBe("running");
    expect(afterCrash?.processedItems).toBe(CRASH_AT);
    expect(afterCrash?.checkpointIndex).toBe(CRASH_AT);

    const itemsAfterCrash = await prisma.payrollItem.findMany({
      where: { jobId: job.id },
      orderBy: { lineIndex: "asc" },
    });
    for (const [i, item] of itemsAfterCrash.entries()) {
      if (i < CRASH_AT) expect(item.status).toBe("completed");
      else expect(item.status).toBe("pending");
    }

    // Worker restart / BullMQ retry: the mock is healthy again.
    txMock.state.failKey = null;
    await processPayroll(job.id);

    const done = await prisma.payrollJob.findUnique({ where: { id: job.id } });
    expect(done?.status).toBe("completed");
    expect(done?.processedItems).toBe(BATCH_SIZE);
    expect(done?.checkpointIndex).toBe(BATCH_SIZE);

    const completed = await prisma.payrollItem.count({
      where: { jobId: job.id, status: "completed" },
    });
    expect(completed).toBe(BATCH_SIZE);

    // No double-pay: the transaction mock saw each idempotency key at most
    // twice (crash item once failed + once retried) and replay of a finished
    // key returns the same transactionId (idempotent).
    const attempts = txMock.state.attempts;
    expect(attempts).toHaveLength(BATCH_SIZE + 1); // crash item attempted twice
    expect(attempts.filter((k) => k === itemKey(job.id, CRASH_AT))).toHaveLength(2);
    expect(new Set(attempts).size).toBe(BATCH_SIZE);
    expect(txMock.state.txByKey.size).toBe(BATCH_SIZE);

    // The first CRASH_AT items were not re-submitted after the restart
    // (checkpoint resume), so they appear exactly once in the attempt log.
    for (let i = 0; i < CRASH_AT; i++) {
      expect(attempts.filter((k) => k === itemKey(job.id, i))).toHaveLength(1);
    }
  });
});