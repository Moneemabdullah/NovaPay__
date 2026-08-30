import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withContext } from "../lib/context.js";

export async function requestIdPlugin(app: FastifyInstance) {
  // Callback style is required for ALS: `done` continues Fastify's request
  // lifecycle from inside the AsyncLocalStorage.run, so the whole remaining
  // chain (downstream hooks, handlers, their awaits) inherits the context.
  // An async hook that merely returns a promise does NOT propagate the store
  // to Fastify's own continuation.
  app.addHook("onRequest", (request, reply, done) => {
    const requestId = String(
      request.headers["x-request-id"] ?? crypto.randomUUID(),
    );
    request.headers["x-request-id"] = requestId;
    reply.header("x-request-id", requestId);
    withContext({ requestId }, done);
  });
}