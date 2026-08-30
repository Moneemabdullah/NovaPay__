import Fastify from "fastify";
import proxy from "@fastify/http-proxy";
import helmet from "@fastify/helmet";
import { envVars } from "./config/env.utils.js";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { httpMetricsHooks } from "./lib/metrics.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";

const routes: Record<string, string> = {
  "/accounts": envVars.ACCOUNT_SERVICE_URL,
  "/transactions": envVars.TRANSACTION_SERVICE_URL,
  "/transfers": envVars.TRANSACTION_SERVICE_URL,
  "/ledger": envVars.LEDGER_SERVICE_URL,
  "/fx": envVars.FX_SERVICE_URL,
  "/payroll": envVars.PAYROLL_SERVICE_URL,
  "/admin": envVars.ADMIN_SERVICE_URL,
};

export async function buildApp() {
  const app = Fastify({
    logger: { level: envVars.LOG_LEVEL },
  });

  await app.register(helmet);
  await requestIdPlugin(app);
  httpMetricsHooks(app);
  registerErrorHandler(app);
  await app.register(registerRoutes);

  for (const [prefix, upstream] of Object.entries(routes)) {
    await app.register(proxy, {
      upstream,
      prefix,
      rewritePrefix: prefix,
    });
  }

  return app;
}