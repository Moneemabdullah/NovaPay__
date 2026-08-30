import client from "prom-client";
import type { FastifyInstance } from "fastify";

export const SERVICE_NAME = "transaction-service";

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

export const transactionsTotal = new client.Counter({
  name: "transactions_total",
  help: "Total number of transfer requests the transaction service was asked to initiate",
  labelNames: ["service", "type"],
});

export const transactionsFailedTotal = new client.Counter({
  name: "transactions_failed_total",
  help: "Total number of transfer requests rejected or failed (HTTP >= 400)",
  labelNames: ["service", "type"],
});

export const transactionsFailedStatus = new client.Counter({
  name: "transactions_failed_by_status_total",
  help: "Total number of failed transfer requests by HTTP status code",
  labelNames: ["service", "type", "status"],
});

const started = new WeakMap<object, number>();

function isTransferPath(url: string) {
  return /^\/(transactions|transfers)(\/|$)/.test(url);
}

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
    if (isTransferPath(request.url) && reply.statusCode >= 400) {
      const type = request.url.startsWith("/transfers") ? "international" : "domestic";
      transactionsFailedTotal.labels(SERVICE_NAME, type).inc();
      transactionsFailedStatus
        .labels(SERVICE_NAME, type, String(reply.statusCode))
        .inc();
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