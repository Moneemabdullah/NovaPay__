import client from "prom-client";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { envVars } from "../config/env.utils.js";

export const SERVICE_NAME = "payroll-service";

client.register.setDefaultLabels({ service: SERVICE_NAME });

let defaultMetricsStarted = false;
if (!defaultMetricsStarted) {
  defaultMetricsStarted = true;
  client.collectDefaultMetrics();
}

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds (p50/p95/p99 available as client-side percentiles)",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

let queue: Queue | undefined;

// Lazily-opened handle on the BullMQ queue the payroll worker consumes.
function payrollQueue() {
  if (!queue)
    queue = new Queue(envVars.QUEUE_NAME, {
      connection: { url: envVars.REDIS_URL },
    });
  return queue;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`queue depth collect timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const payrollQueueDepth = new client.Gauge({
  name: "payroll_queue_depth",
  help: "Number of payroll line items current awaiting processing in the worker's BullMQ queue",
  async collect() {
    const counts = await withTimeout(
      payrollQueue().getJobCounts("waiting", "active", "delayed", "failed"),
      2000,
    ).catch(() => undefined);
    const depth = counts
      ? counts.waiting + counts.active + counts.delayed + counts.failed
      : 0;
    payrollQueueDepth.set(depth);
  },
});

const started = new WeakMap<object, number>();

export function httpMetricsHooks(app: FastifyInstance) {
  app.addHook("onRequest", (request, _reply, done) => {
    started.set(request, Date.now());
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    const start = started.get(request);
    if (start !== undefined) {
      const route = request.routeOptions?.url ?? request.url;
      httpRequestDuration
        .labels(SERVICE_NAME, request.method, route, String(reply.statusCode))
        .observe((Date.now() - start) / 1000);
      started.delete(request);
    }
    done();
  });
}

export async function metricsRoute(app: FastifyInstance) {
  app.get("/metrics", async (_request, reply) =>
    reply
      .type(client.register.contentType)
      .send(await client.register.metrics()),
  );
}