import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { metricsRoute } from "../lib/metrics.js";
import { walletRoutes } from "./wallet.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(metricsRoute);
  await app.register(walletRoutes);
}
