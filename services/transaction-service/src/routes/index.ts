import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { transactionRoutes } from "./transaction.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(transactionRoutes);
}
