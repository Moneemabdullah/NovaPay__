import crypto from "node:crypto";
import { Queue } from "bullmq";
import { context, propagation } from "@opentelemetry/api";
import { prisma } from "../lib/prisma.js";
import { envVars } from "../config/env.utils.js";
import { getTracer } from "../lib/otel.js";
import { SpanStatusCode } from "@opentelemetry/api";

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
  const tracer = getTracer();
  return tracer.startActiveSpan("payroll.process", async (span) => {
    try {
      span.setAttribute("payroll.job_id", jobId);
      const job = await prisma.payrollJob.findUnique({ where: { id: jobId } });
      if (!job) throw new Error("Payroll job not found");
      await prisma.payrollJob.update({
        where: { id: jobId },
        data: { status: "running" },
      });
      const items = await prisma.payrollItem.findMany({
        where: { jobId, status: { not: "completed" } },
        orderBy: { lineIndex: "asc" },
      });
      span.setAttribute("payroll.total_items", items.length);
      for (const item of items) {
        await tracer.startActiveSpan("payroll.process_item", async (itemSpan) => {
          try {
            itemSpan.setAttribute("payroll.line_index", item.lineIndex);
            itemSpan.setAttribute("payroll.recipient_wallet", item.recipientWalletId);
            const headers: Record<string, string> = {
              "content-type": "application/json",
              "idempotency-key": item.idempotencyKey,
            };
            propagation.inject(context.active(), headers);
            const response = await fetch(
              `${envVars.TRANSACTION_SERVICE_URL}/transactions`,
              {
                method: "POST",
                headers,
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
            itemSpan.end();
          } catch (e: any) {
            itemSpan.recordException(e);
            itemSpan.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            itemSpan.end();
            throw e;
          }
        });
      }
      await prisma.payrollJob.update({
        where: { id: jobId },
        data: { status: "completed" },
      });
      span.end();
    } catch (e: any) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      span.end();
      throw e;
    }
  });
}
