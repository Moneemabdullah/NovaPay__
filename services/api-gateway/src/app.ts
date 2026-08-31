import Fastify from "fastify";
import proxy from "@fastify/http-proxy";
import helmet from "@fastify/helmet";
import { envVars } from "./config/env.utils.js";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { httpMetricsHooks } from "./lib/metrics.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";
import { registerTracingHooks } from "./middlewares/tracing.js";

const routes: { prefix: string; upstream: string; rewritePrefix: string }[] = [
  { prefix: "/accounts", upstream: envVars.ACCOUNT_SERVICE_URL, rewritePrefix: "/" },
  { prefix: "/transactions", upstream: envVars.TRANSACTION_SERVICE_URL, rewritePrefix: "/transactions" },
  { prefix: "/transfers", upstream: envVars.TRANSACTION_SERVICE_URL, rewritePrefix: "/transfers" },
  { prefix: "/ledger", upstream: envVars.LEDGER_SERVICE_URL, rewritePrefix: "/" },
  { prefix: "/fx", upstream: envVars.FX_SERVICE_URL, rewritePrefix: "/" },
  { prefix: "/payroll", upstream: envVars.PAYROLL_SERVICE_URL, rewritePrefix: "/" },
  { prefix: "/admin", upstream: envVars.ADMIN_SERVICE_URL, rewritePrefix: "/" },
];

export async function buildApp() {
  const app = Fastify({
    logger: { level: envVars.LOG_LEVEL },
  });

  await app.register(helmet);
  await requestIdPlugin(app);
  httpMetricsHooks(app);
  registerErrorHandler(app);
  registerTracingHooks(app);
  await app.register(registerRoutes);

  for (const { prefix, upstream, rewritePrefix } of routes) {
    await app.register(proxy, {
      upstream,
      prefix,
      rewritePrefix,
    });
  }

  return app;
}