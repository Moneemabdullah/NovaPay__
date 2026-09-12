import crypto from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { Queue } from "bullmq";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { envVars } from "../src/config/env.utils.js";

// Proves a normal-size batch passes route validation and is accepted (202)
// through the real DB + queue path. Oversized rejection is covered in the
// unit suite (no DB needed); large-batch processing is covered by the
// resumability/concurrency suites.
describe("POST /jobs acceptance (integration)", () => {
  const jobIds: string[] = [];

  afterEach(async () => {
    if (jobIds.length) {
      await prisma.payrollItem.deleteMany({
        where: { jobId: { in: jobIds } },
      });
      await prisma.payrollJob.deleteMany({
        where: { id: { in: jobIds } },
      });
      // Remove our own test jobs from the shared queue so they are never
      // picked up by a running worker; only touch jobs we created.
      const queue = new Queue(envVars.QUEUE_NAME, {
        connection: { url: envVars.REDIS_URL },
      });
      try {
        const waiting = await queue.getWaiting();
        for (const j of waiting) {
          if (jobIds.includes((j.data as { jobId?: string })?.jobId ?? "")) {
            await j.remove();
          }
        }
      } finally {
        await queue.close();
      }
      jobIds.length = 0;
    }
  });

  it("accepts a normal batch with 202", async () => {
    const app = await buildApp();
    const employerAccountId = crypto.randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        employerAccountId,
        items: [
          { recipientWalletId: crypto.randomUUID(), amountCents: 100 },
          { recipientWalletId: crypto.randomUUID(), amountCents: 200 },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.totalItems).toBe(2);
    expect(body.status).toBe("queued");
    jobIds.push(body.jobId);
  });
});
