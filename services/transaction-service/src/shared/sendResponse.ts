import type { FastifyReply } from "fastify";

export function sendResponse<T>(reply: FastifyReply, status: number, data: T) {
  return reply.code(status).send({
    status: "success",
    requestId: reply.request.headers["x-request-id"] ?? null,
    data,
  });
}
