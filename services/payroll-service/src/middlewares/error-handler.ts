import type { FastifyError, FastifyInstance } from "fastify";
import { AppError } from "../errorHelpers/AppError.js";

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Prisma client-side validation (malformed UUIDs, wrong scalar types)
    // is a client error, not a server fault — and its message embeds
    // source file paths, so it must never reach the response as-is.
    // P2023 (malformed values reaching the database, e.g. non-UUID
    // strings for uuid columns) is likewise always a client-data problem.
    if (
      typeof error?.name === "string" &&
      (error.name === "PrismaClientValidationError" ||
        (error.name === "PrismaClientKnownRequestError" &&
          (error as any).code === "P2023"))
    )
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "Invalid request parameters",
        requestId: request.headers["x-request-id"] ?? null,
      });
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
