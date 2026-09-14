import type { FastifyInstance } from "fastify";
import { fail } from "../lib/fail.js";
import { transactionsTotal } from "../lib/metrics.js";
import { initiate } from "../services/transaction.service.js";
import { listHistory, parseHistoryQuery } from "../services/history.service.js";
import { recoverStaleTransactions } from "../services/recovery.service.js";

export async function transactionRoutes(app: FastifyInstance) {
  app.post("/transactions", (q, r) => {
    transactionsTotal.labels("transaction-service", "domestic").inc();
    return initiate(q, r);
  });
  app.get<{
    Querystring: { walletId?: string; limit?: string; cursor?: string };
  }>("/transactions", async (request, reply) => {
    const parsed = parseHistoryQuery(request.query);
    if ("status" in parsed)
      return fail(reply, parsed.status, parsed.error, parsed.message);
    return listHistory(parsed);
  });
  app.post("/transfers/international", (q, r) => {
    transactionsTotal.labels("transaction-service", "international").inc();
    return initiate(q, r, true);
  });
  app.post("/international", (q, r) => {
    transactionsTotal.labels("transaction-service", "international").inc();
    return initiate(q, r, true);
  });
  // Internal operator trigger sharing the scheduler's implementation
  // (stale-only scan, per-transaction ownership lock, idempotent execute).
  app.post("/internal/recover", async () => recoverStaleTransactions());
}
