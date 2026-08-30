import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { httpMetricsHooks } from "./lib/metrics.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await requestIdPlugin(app);
  httpMetricsHooks(app);
  registerErrorHandler(app);
  await app.register(registerRoutes);
  return app;
}
