import crypto from "node:crypto";
import { Queue } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { envVars } from "../config/env.utils.js";

export async function createPayrollJob(input: {
  employerAccountId: string;
  items: { recipientWalletId: string; amountCents: number }[];
}) {
  const { employerAccountId, items } = input;
  const job = await prisma.$transaction(async (db) => {
    const j = await db.payrollJob.create({
      data: { employerAccountId, totalItems: items.length },
    });
    await db.payrollItem.createMany({
      data: items.map((x, i) => ({
        jobId: j.id,
        lineIndex: i,
        recipientWalletId: x.recipientWalletId,
        amountCents: BigInt(x.amountCents),
        idempotencyKey: crypto
          .createHash("sha256")
          .update(`${j.id}:${i}`)
          .digest("hex"),
      })),
    });
    return j;
  });
  await new Queue(`payroll:${employerAccountId}`, {
    connection: { url: envVars.REDIS_URL },
  }).add("process", { jobId: job.id }, { attempts: 3 });
  return job;
}

export async function getPayrollJob(jobId: string) {
  return prisma.payrollJob.findUnique({ where: { id: jobId } });
}

export async function processPayroll(jobId: string) {
  const job = await prisma.payrollJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error("Payroll job not found");
  await prisma.payrollJob.update({
    where: { id: jobId },
    data: { status: "running" },
  });
  for (const item of await prisma.payrollItem.findMany({
    where: { jobId, status: { not: "completed" } },
    orderBy: { lineIndex: "asc" },
  })) {
    const response = await fetch(
      `${envVars.TRANSACTION_SERVICE_URL}/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": item.idempotencyKey,
        },
        body: JSON.stringify({
          senderWalletId: job.employerAccountId,
          recipientWalletId: item.recipientWalletId,
          amountCents: Number(item.amountCents),
          currency: "USD",
        }),
      },
    );
    if (!response.ok) throw new Error(`transaction failed ${response.status}`);
    const tx = await response.json();
    await prisma.$transaction([
      prisma.payrollItem.update({
        where: { jobId_lineIndex: { jobId, lineIndex: item.lineIndex } },
        data: { status: "completed", transactionId: tx.transactionId },
      }),
      prisma.payrollJob.update({
        where: { id: jobId },
        data: {
          processedItems: { increment: 1 },
          checkpointIndex: item.lineIndex + 1,
        },
      }),
    ]);
  }
  await prisma.payrollJob.update({
    where: { id: jobId },
    data: { status: "completed" },
  });
}
