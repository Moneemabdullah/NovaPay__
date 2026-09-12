import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import {
  createPayrollJob,
  getPayrollJob,
} from "../services/payroll.service.js";

// Operational upper bound, not a pricing/business rule: 5000 typical items
// serialize to ~0.4 MB, comfortably under Fastify's 1 MB default body limit
// and the 10m Nginx limit, while keeping single-batch DB/queue work bounded.
export const MAX_PAYROLL_ITEMS = 5000;

export async function payrollRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      employerAccountId?: string;
      items?: { recipientWalletId: string; amountCents: number }[];
    };
  }>("/jobs", async (request, reply) => {
    const { employerAccountId, items = [] } = request.body;
    if (
      !employerAccountId ||
      !items.length ||
      items.length > MAX_PAYROLL_ITEMS ||
      items.some(
        (x) =>
          !x.recipientWalletId ||
          !Number.isSafeInteger(x.amountCents) ||
          x.amountCents <= 0,
      )
    )
      return fail(
        reply,
        400,
        "VALIDATION_ERROR",
        "Employer and valid items are required",
      );
    const job = await createPayrollJob({ employerAccountId, items });
    return reply
      .code(202)
      .send({ jobId: job.id, totalItems: items.length, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const job = await getPayrollJob(request.params.id);
    return (
      job ?? fail(reply, 404, "PAYROLL_JOB_NOT_FOUND", "Job was not found")
    );
  });
}
