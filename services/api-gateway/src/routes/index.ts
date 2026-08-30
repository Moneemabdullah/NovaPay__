import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { metricsRoute } from "../lib/metrics.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(metricsRoute);
}
