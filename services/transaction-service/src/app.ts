import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  registerErrorHandler(app);
  await app.register(registerRoutes);
  return app;
}
