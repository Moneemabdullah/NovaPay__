import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { envVars } from "../config/env.utils.js";
import { getContext } from "./context.js";

const isDev = envVars.NODE_ENV === "development";
const logDir = path.join(process.cwd(), ".logger");
const appLogPath = path.join(logDir, "app.log");
const errorLogPath = path.join(logDir, "error.log");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const streams: pino.StreamEntry[] = [
  { level: "error", stream: pino.destination({ dest: errorLogPath, sync: false }) },
  { level: envVars.LOG_LEVEL, stream: pino.destination({ dest: appLogPath, sync: false }) },
];

if (isDev) {
  streams.push({
    level: "debug",
    stream: pino.transport({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    }),
  });
}

// Safety net: never let secret-shaped keys reach the log output. The KEK
// (FIELD_ENCRYPTION_KEK) is the concrete case; crypto.service.ts must never
// pass it to a logger either. Redaction is applied for any key listed here or
// nested one level deep from the record root.
export const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "secret",
  "*.secret",
  "authorization",
  "*.authorization",
  "apiKey",
  "*.apiKey",
  "kek",
  "*.kek",
  "dek",
  "dekWrapped",
  "*.dekWrapped",
  "FIELD_ENCRYPTION_KEK",
  "*.FIELD_ENCRYPTION_KEK",
];

export function loggerOptions(): pino.LoggerOptions {
  return {
    level: isDev ? "debug" : envVars.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };
}

export const logger = pino(loggerOptions(), pino.multistream(streams));

const contextRecord = (moduleName: string) => {
  const ctx = getContext();
  return {
    module: moduleName,
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(ctx?.userId ? { userId: ctx.userId } : {}),
    ...(ctx?.transactionId ? { transactionId: ctx.transactionId } : {}),
  };
};

export const createLogger = (moduleName: string) => ({
  debug: (msg: string, data?: unknown) =>
    logger.debug({ ...(data as object), ...contextRecord(moduleName) }, msg),
  info: (msg: string, data?: unknown) =>
    logger.info({ ...(data as object), ...contextRecord(moduleName) }, msg),
  warn: (msg: string, data?: unknown) =>
    logger.warn({ ...(data as object), ...contextRecord(moduleName) }, msg),
  error: (msg: string, error?: unknown) =>
    logger.error({ error, ...contextRecord(moduleName) }, msg),
});