import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { envVars } from "./config/env.utils.js";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { httpMetricsHooks } from "./lib/metrics.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";
import { registerTracingHooks } from "./middlewares/tracing.js";
import { registerServiceAuth } from "./middlewares/service-auth.js";
import { REDACT_PATHS } from "./lib/logger.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: envVars.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
  });
  await app.register(helmet);
  await requestIdPlugin(app);
  // Normalize missing bodies so route destructuring never throws: every
  // route validates the (possibly empty) object and returns its own 400.
  app.addHook("preValidation", (request, _reply, done) => {
    if (
      (request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH") &&
      request.body === undefined
    )
      request.body = {};
    done();
  });
  registerServiceAuth(
    app,
    () => ({
      "transaction-service": envVars.PEER_TRANSACTION_SERVICE_TOKEN,
      "api-gateway": envVars.PEER_API_GATEWAY_TOKEN,
    }),
    { "transaction-service": ["*"], "api-gateway": ["*"] },
  );
  httpMetricsHooks(app);
  registerErrorHandler(app);
  registerTracingHooks(app);
  await app.register(registerRoutes);
  return app;
}
