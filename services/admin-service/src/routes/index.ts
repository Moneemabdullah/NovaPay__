import type { FastifyInstance } from "fastify";
import { healthRoutes } from "./health.js";
import { incidentRoutes } from "./incident.routes.js";

export async function registerRoutes(app: FastifyInstance) {
  await app.register(healthRoutes);
  await app.register(incidentRoutes);
}
