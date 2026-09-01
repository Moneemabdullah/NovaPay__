import { initTracing } from "./lib/otel.js";
import { Worker } from "bullmq";
import { envVars } from "./config/env.utils.js";
import { processPayroll } from "./services/payroll.service.js";

if (envVars.NODE_ENV !== "test") {
  initTracing();
}

new Worker(envVars.QUEUE_NAME, (j) => processPayroll(j.data.jobId), {
  connection: { url: envVars.REDIS_URL },
  concurrency: 1,
});
