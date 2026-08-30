import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { ledgerRoutes } from "./ledger.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(ledgerRoutes);
}
