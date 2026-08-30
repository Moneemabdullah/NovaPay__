import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { execute, initiate } from "../services/transaction.service.js";

export async function transactionRoutes(app: FastifyInstance) {
  app.post("/transactions", (q, r) => initiate(q, r));
  app.post("/transfers/international", (q, r) => initiate(q, r, true));
  app.post("/internal/recover", async () => {
    const xs = await prisma.transaction.findMany({
      where: {
        status: "PROCESSING",
        processingStartedAt: { lt: new Date(Date.now() - 60000) },
      },
    });
    for (const x of xs) await execute(x);
    return { recovered: xs.length };
  });
}
