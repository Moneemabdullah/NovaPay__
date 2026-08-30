import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import {
  type LedgerEntryInput,
  auditVerify,
  createBatch,
  getBatch,
  invariantCheck,
  validateBatch,
  violations,
} from "../services/ledger.service.js";

export async function ledgerRoutes(app: FastifyInstance) {
  app.get("/metrics", async (_req, reply) =>
    reply
      .type("text/plain")
      .send(`ledger_invariant_violations_total ${violations}\n`),
  );

  app.post<{ Body: { transactionId?: string; entries?: LedgerEntryInput[] } }>(
    "/batches",
    async (request, reply) => {
      const { transactionId, entries = [] } = request.body;
      const validationError = validateBatch(transactionId, entries);
      if (validationError)
        return fail(
          reply,
          validationError.status,
          validationError.error,
          validationError.message,
        );
      const result = await createBatch({
        transactionId: transactionId!,
        entries,
      });
      if (result.replayed) return result;
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { transactionId: string } }>(
    "/batches/:transactionId",
    async (request, reply) => {
      const transaction = await getBatch(request.params.transactionId);
      return (
        transaction ??
        fail(
          reply,
          404,
          "LEDGER_TRANSACTION_NOT_FOUND",
          "Ledger transaction not found",
        )
      );
    },
  );

  app.get("/invariant-check", async () => invariantCheck());

  app.get("/audit/verify", async () => auditVerify());
}
