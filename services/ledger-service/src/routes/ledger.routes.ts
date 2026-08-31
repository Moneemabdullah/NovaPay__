import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import {
  type LedgerEntryInput,
  auditVerify,
  createBatch,
  getBatch,
  invariantCheck,
  validateBatch,
} from "../services/ledger.service.js";

export async function ledgerRoutes(app: FastifyInstance) {
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
      if (!transaction) {
        return fail(
          reply,
          404,
          "LEDGER_TRANSACTION_NOT_FOUND",
          "Ledger transaction not found",
        );
      }
      return {
        ...transaction,
        entries: transaction.entries.map((entry) => ({
          ...entry,
          id: entry.id.toString(),
          amountCents: entry.amountCents.toString(),
          fxRate: entry.fxRate ? entry.fxRate.toString() : undefined,
        })),
      };
    },
  );

  app.get("/invariant-check", async () => invariantCheck());

  app.get("/audit/verify", async () => auditVerify());
}
