import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Redis } from "ioredis";
import { prisma } from "../src/lib/prisma.js";
import { envVars } from "../src/config/env.utils.js";
import { runPayrollJobExclusive } from "../src/services/payroll.service.js";
import {
  acquireEmployerLock,
  employerLockKey,
  EmployerLockBusyError,
} from "../src/lib/employerLock.js";
import { startTransactionMock } from "./helpers/mockTransactionService.js";

async function createJob(employerAccountId: string, itemCount: number) {
  const job = await prisma.payrollJob.create({
    data: { employerAccountId, totalItems: itemCount },
  });
  await prisma.payrollItem.createMany({
    data: Array.from({ length: itemCount }, (_, i) => ({
      jobId: job.id,
      lineIndex: i,
      recipientWalletId: crypto.randomUUID(),
      amountCents: BigInt(100 + i),
      idempotencyKey: crypto
        .createHash("sha256")
        .update(`${job.id}:${i}`)
        .digest("hex"),
    })),
  });
  return job;
}

describe("payroll per-employer concurrency (integration)", () => {
  let txMock: ReturnType<typeof startTransactionMock>;
  let redis: Redis;
  const employers: string[] = [];

  const track = (employerAccountId: string) => {
    employers.push(employerAccountId);
    return employerAccountId;
  };

  beforeAll(async () => {
    txMock = startTransactionMock();
    await txMock.start();
    envVars.TRANSACTION_SERVICE_URL = txMock.url();
    redis = new Redis(envVars.REDIS_URL);
  });

  afterAll(async () => {
    await txMock.close();
    redis.disconnect();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.payrollItem.deleteMany({});
    await prisma.payrollJob.deleteMany({});
    if (employers.length) {
      await redis.del(employers.map(employerLockKey));
      employers.length = 0;
    }
  });

  it("defers a same-employer job while its lease is held, without burning attempts", async () => {
    const employer = track(crypto.randomUUID());
    const job = await createJob(employer, 1);
    const token = await acquireEmployerLock(redis, employer, "holder", 60_000);
    expect(token).toBe("holder");
    // Wrapper uses the real shared-queue payload shape (employer inline).
    await expect(
      runPayrollJobExclusive({ jobId: job.id, employerAccountId: employer }),
    ).rejects.toBeInstanceOf(EmployerLockBusyError);
    // Lock untouched by the failed contender; job row untouched (not started).
    expect(await redis.get(employerLockKey(employer))).toBe("holder");
    const untouched = await prisma.payrollJob.findUnique({
      where: { id: job.id },
    });
    expect(untouched?.status).toBe("queued");
  });

  // Emulates the worker's defer-and-retry path: a contender waits for the
  // lease to free instead of failing the job.
  async function runWithDeferral(
    jobId: string,
    employerAccountId: string,
    tries = 50,
  ) {
    for (let i = 0; i < tries; i++) {
      try {
        return await runPayrollJobExclusive({ jobId, employerAccountId });
      } catch (e) {
        if (!(e instanceof EmployerLockBusyError)) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new Error("lock never freed");
  }

  it("two same-employer jobs both complete and release their locks", async () => {
    const employer = track(crypto.randomUUID());
    const j1 = await createJob(employer, 2);
    const j2 = await createJob(employer, 2);
    const txBefore = txMock.state.txByKey.size;
    // One contender necessarily defers while the other holds the lease;
    // both finish exactly once with no double-pay (idempotent items).
    await Promise.all([
      runWithDeferral(j1.id, employer),
      runWithDeferral(j2.id, employer),
    ]);
    for (const j of [j1, j2]) {
      const done = await prisma.payrollJob.findUnique({ where: { id: j.id } });
      expect(done?.status).toBe("completed");
      expect(done?.processedItems).toBe(2);
    }
    expect(await redis.exists(employerLockKey(employer))).toBe(0);
    expect(txMock.state.txByKey.size).toBe(txBefore + 4);
  });

  it("different employers complete concurrently", async () => {
    const empA = track(crypto.randomUUID());
    const empB = track(crypto.randomUUID());
    const [jA, jB] = await Promise.all([
      createJob(empA, 2),
      createJob(empB, 2),
    ]);
    await Promise.all([
      runPayrollJobExclusive({ jobId: jA.id, employerAccountId: empA }),
      runPayrollJobExclusive({ jobId: jB.id, employerAccountId: empB }),
    ]);
    for (const j of [jA, jB]) {
      const done = await prisma.payrollJob.findUnique({ where: { id: j.id } });
      expect(done?.status).toBe("completed");
    }
    expect(await redis.exists(employerLockKey(empA))).toBe(0);
    expect(await redis.exists(employerLockKey(empB))).toBe(0);
  });

  it("releases the lock when processing fails, preserving retry semantics", async () => {
    const employer = track(crypto.randomUUID());
    const job = await createJob(employer, 1);
    txMock.state.failKey = crypto
      .createHash("sha256")
      .update(`${job.id}:0`)
      .digest("hex");
    await expect(
      runPayrollJobExclusive({ jobId: job.id, employerAccountId: employer }),
    ).rejects.toThrow();
    // Lock freed so a BullMQ retry can proceed; error propagates for retry.
    expect(await redis.exists(employerLockKey(employer))).toBe(0);
    const failed = await prisma.payrollJob.findUnique({
      where: { id: job.id },
    });
    expect(failed?.status).toBe("running");
    // Retry succeeds once the downstream recovers (idempotent resume).
    txMock.state.failKey = null;
    await runPayrollJobExclusive({ jobId: job.id, employerAccountId: employer });
    const done = await prisma.payrollJob.findUnique({ where: { id: job.id } });
    expect(done?.status).toBe("completed");
  });

  it("a stale lock does not block an employer", async () => {
    const employer = track(crypto.randomUUID());
    const job = await createJob(employer, 1);
    await acquireEmployerLock(redis, employer, "crashed-worker", 50);
    await new Promise((r) => setTimeout(r, 150)); // lease expires
    await runPayrollJobExclusive({ jobId: job.id, employerAccountId: employer });
    const done = await prisma.payrollJob.findUnique({ where: { id: job.id } });
    expect(done?.status).toBe("completed");
    expect(await redis.exists(employerLockKey(employer))).toBe(0);
  });

  it("falls back to a DB lookup for legacy payloads without employerAccountId", async () => {
    const employer = track(crypto.randomUUID());
    const job = await createJob(employer, 1);
    await runPayrollJobExclusive({ jobId: job.id });
    const done = await prisma.payrollJob.findUnique({ where: { id: job.id } });
    expect(done?.status).toBe("completed");
  });
});
