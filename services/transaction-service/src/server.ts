import { initTracing } from "./lib/otel.js";
import { envVars } from "./config/env.utils.js";
import { createLogger } from "./lib/logger.js";
import { buildApp } from "./app.js";
import { startRecoveryScheduler } from "./services/recovery.service.js";

if (envVars.NODE_ENV !== "test") {
  initTracing();
  const app = await buildApp();
  await app.listen({ port: envVars.PORT, host: "0.0.0.0" });
  createLogger("server").info(
    `transaction-service listening on port ${envVars.PORT}`,
  );
  const stopRecovery = startRecoveryScheduler();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      stopRecovery();
      await app.close();
    });
  }
}
