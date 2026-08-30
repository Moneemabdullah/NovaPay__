import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { envVars } from "../config/env.utils.js";

const isDev = envVars.NODE_ENV === "development";
const logDir = path.join(process.cwd(), ".logger");
const appLogPath = path.join(logDir, "app.log");
const errorLogPath = path.join(logDir, "error.log");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const streams: pino.StreamEntry[] = [
  { level: "error", stream: pino.destination({ dest: errorLogPath, sync: false }) },
  { level: "debug", stream: pino.destination({ dest: appLogPath, sync: false }) },
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

export const logger = pino(
  { level: isDev ? "debug" : envVars.LOG_LEVEL },
  pino.multistream(streams),
);

export const createLogger = (moduleName: string) => ({
  debug: (msg: string, data?: unknown) =>
    logger.debug({ module: moduleName, ...(data as object) }, msg),
  info: (msg: string, data?: unknown) =>
    logger.info({ module: moduleName, ...(data as object) }, msg),
  warn: (msg: string, data?: unknown) =>
    logger.warn({ module: moduleName, ...(data as object) }, msg),
  error: (msg: string, error?: unknown) =>
    logger.error({ module: moduleName, error }, msg),
});