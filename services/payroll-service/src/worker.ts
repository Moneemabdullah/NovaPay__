import { Worker } from "bullmq";
import { envVars } from "./config/env.utils.js";
import { processPayroll } from "./services/payroll.service.js";

new Worker(envVars.QUEUE_NAME, (j) => processPayroll(j.data.jobId), {
  connection: { url: envVars.REDIS_URL },
  concurrency: 1,
});
