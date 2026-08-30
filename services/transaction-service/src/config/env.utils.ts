import dotenv from "dotenv";
import { z } from "zod";
import { AppError } from "../errorHelpers/AppError.js";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3002),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1),
  ACCOUNT_SERVICE_URL: z.string().min(1),
  LEDGER_SERVICE_URL: z.string().min(1),
  FX_SERVICE_URL: z.string().min(1),
});

const loadEnv = () => {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((err) => `${err.path.join(".")}: ${err.message}`)
      .join("\n");

    throw new AppError(
      500,
      "INVALID_ENV",
      `Invalid environment variables:\n${errors}`,
    );
  }

  const env = parsed.data;

  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    LOG_LEVEL: env.LOG_LEVEL,
    DATABASE_URL: env.DATABASE_URL,
    ACCOUNT_SERVICE_URL: env.ACCOUNT_SERVICE_URL,
    LEDGER_SERVICE_URL: env.LEDGER_SERVICE_URL,
    FX_SERVICE_URL: env.FX_SERVICE_URL,
  };
};

export const envVars = loadEnv();