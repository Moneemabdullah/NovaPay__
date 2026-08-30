import { Prisma } from "@prisma/client";
import { AppError } from "./AppError.js";

export function handlePrismaError(error: unknown): AppError {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002":
        return new AppError(
          409,
          "CONFLICT",
          "A record with those values already exists",
        );
      default:
        return new AppError(400, "DATABASE_ERROR", error.message);
    }
  }
  if (error instanceof AppError) return error;
  return new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
}
