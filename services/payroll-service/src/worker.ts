import { Worker } from "bullmq";
import { config } from "./config.js";
import { processPayroll } from "./services/payroll.service.js";

new Worker(config.queueName, (j) => processPayroll(j.data.jobId), {
  connection: { url: config.redisUrl },
  concurrency: 1,
});
