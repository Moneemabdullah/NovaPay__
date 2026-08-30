import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { fail } from "../lib/fail.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", service: "fx-service" }));
  app.get("/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return fail(reply, 503, "DEPENDENCY_UNAVAILABLE", "Database unavailable");
    }
  });
}
