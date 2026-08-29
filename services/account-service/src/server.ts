import { config } from "./config.js";
import { buildApp } from "./app.js";

if (config.nodeEnv !== "test") {
  const app = await buildApp();
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
