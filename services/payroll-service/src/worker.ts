import { initTracing } from "./lib/otel.js";
import { DelayedError, Worker, type Job } from "bullmq";
import { envVars } from "./config/env.utils.js";
import {
  EmployerLockBusyError,
  EMPLOYER_LOCK_RETRY_DELAY_MS,
  WORKER_CONCURRENCY,
} from "./lib/employerLock.js";
import {
  runPayrollJobExclusive,
  type PayrollJobData,
} from "./services/payroll.service.js";

if (envVars.NODE_ENV !== "test") {
  initTracing();
}

// One shared queue with parallel slots; per-employer serialization is
// enforced by the lease in runPayrollJobExclusive. On lock contention the
// job is moved back to delayed WITHOUT consuming one of its 3 attempts
// (moveToDelayed uses skipAttempt), and DelayedError tells the worker to
// skip the failed path. No busy-wait: the slot is freed immediately.
new Worker(
  envVars.QUEUE_NAME,
  async (job: Job, jobToken?: string) => {
    try {
      await runPayrollJobExclusive(job.data as PayrollJobData);
    } catch (e) {
      if (e instanceof EmployerLockBusyError) {
        // Best effort: even if the move fails, the DelayedError signal
        // below still avoids burning an attempt (the job stalls and retries).
        await job
          .moveToDelayed(Date.now() + EMPLOYER_LOCK_RETRY_DELAY_MS, jobToken)
          .catch(() => undefined);
        throw new DelayedError();
      }
      throw e;
    }
  },
  {
    connection: { url: envVars.REDIS_URL },
    concurrency: WORKER_CONCURRENCY,
  },
);
