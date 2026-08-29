import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { walletRoutes } from "./wallet.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(walletRoutes);
}
