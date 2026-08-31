import { initTracing } from "./lib/otel.js";
import { envVars } from "./config/env.utils.js";
import { buildApp } from "./app.js";

if (envVars.NODE_ENV !== "test") {
  initTracing();
  const app = await buildApp();
  await app.listen({ port: envVars.PORT, host: "0.0.0.0" });
}
