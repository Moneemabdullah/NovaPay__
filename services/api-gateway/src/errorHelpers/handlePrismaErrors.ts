import { AppError } from "./AppError.js";

export function handlePrismaError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred");
}
