import { envVars } from "./config/env.utils.js";
import { buildApp } from "./app.js";

if (envVars.NODE_ENV !== "test") {
  const app = await buildApp();
  await app.listen({ port: envVars.PORT, host: "0.0.0.0" });
}