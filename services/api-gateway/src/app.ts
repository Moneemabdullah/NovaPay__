import Fastify from "fastify";
import proxy from "@fastify/http-proxy";
import helmet from "@fastify/helmet";
import { config } from "./config.js";
import { requestIdPlugin } from "./middlewares/request-id.js";
import { registerErrorHandler } from "./middlewares/error-handler.js";
import { registerRoutes } from "./routes/index.js";

const routes: Record<string, string> = {
  "/accounts": config.serviceUrls.accounts,
  "/transactions": config.serviceUrls.transactions,
  "/transfers": config.serviceUrls.transactions,
  "/ledger": config.serviceUrls.ledger,
  "/fx": config.serviceUrls.fx,
  "/payroll": config.serviceUrls.payroll,
  "/admin": config.serviceUrls.admin,
};

export async function buildApp() {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(requestIdPlugin);
  registerErrorHandler(app);
  await app.register(registerRoutes);
  for (const [prefix, upstream] of Object.entries(routes))
    await app.register(proxy, { upstream, prefix, rewritePrefix: "" });
  return app;
}
