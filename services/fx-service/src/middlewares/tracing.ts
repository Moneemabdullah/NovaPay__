import type { FastifyInstance } from "fastify";
import { getTracer } from "../lib/otel.js";

export function registerTracingHooks(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    const tracer = getTracer();
    const span = tracer.startSpan(`${request.method} ${request.routeOptions?.url || request.url}`, {
      attributes: {
        "http.method": request.method,
        "http.url": request.url,
      },
    });
    (request as any)._otelSpan = span;
  });

  app.addHook("onResponse", async (request, reply) => {
    const span = (request as any)._otelSpan;
    if (span) {
      span.setAttribute("http.status_code", reply.statusCode);
      span.end();
    }
  });

  app.addHook("onError", async (request, _reply, error) => {
    const span = (request as any)._otelSpan;
    if (span) {
      span.setAttribute("error.name", error.name);
      span.setAttribute("error.message", error.message);
      span.end();
    }
  });
}
