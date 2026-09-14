import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { envVars } from "./config/env.utils.js";
import { REDACT_PATHS } from "./lib/logger.js";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { httpMetricsHooks } from "./lib/metrics.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";
import { registerServiceAuth } from "./middlewares/service-auth.js";
import { registerTracingHooks } from "./middlewares/tracing.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: envVars.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
  });
  await app.register(helmet);
  await requestIdPlugin(app);
  registerServiceAuth(
    app,
    () => ({
      "api-gateway": envVars.PEER_API_GATEWAY_TOKEN,
      "transaction-service": envVars.PEER_TRANSACTION_SERVICE_TOKEN,
    }),
    {
      "api-gateway": ["POST /quote", "GET /quote*"],
      "transaction-service": ["POST /quote/*"],
    },
  );
  httpMetricsHooks(app);
  registerErrorHandler(app);
  registerTracingHooks(app);
  await app.register(registerRoutes);
  return app;
}
