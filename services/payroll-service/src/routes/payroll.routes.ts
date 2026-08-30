import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import {
  createPayrollJob,
  getPayrollJob,
} from "../services/payroll.service.js";

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
