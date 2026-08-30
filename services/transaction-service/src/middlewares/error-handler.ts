import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "../errorHelpers/AppError.js";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const isAppError = error instanceof AppError;
    const statusCode = isAppError ? error.statusCode : 500;
    const code = isAppError ? error.code : "INTERNAL_ERROR";
    if (statusCode >= 500) request.log.error(error);
    return reply.code(statusCode).send({
      error: code,
      message: error.message,
      requestId: request.headers["x-request-id"] ?? null,
    });
  });
}
