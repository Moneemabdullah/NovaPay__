import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

export async function requestIdPlugin(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const requestId = String(
      request.headers["x-request-id"] ?? crypto.randomUUID(),
    );
    request.headers["x-request-id"] = requestId;
    reply.header("x-request-id", requestId);
  });
}
