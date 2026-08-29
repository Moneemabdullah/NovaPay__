import type { FastifyReply } from "fastify";

export function fail(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
) {
  return reply.code(status).send({
    error,
    message,
    requestId: reply.request.headers["x-request-id"] ?? null,
  });
}
