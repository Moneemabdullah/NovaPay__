import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { trace, propagation } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://jaeger:4317";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "ledger-service";

let initialized = false;

export function initTracing() {
  if (initialized) return trace.getTracer(SERVICE_NAME);
  initialized = true;

  console.log(`[otel] Initializing tracing for ${SERVICE_NAME} -> ${OTEL_ENDPOINT}`);

  const exporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });
  const propagator = new W3CTraceContextPropagator();
  const contextManager = new AsyncHooksContextManager().enable();

  propagation.setGlobalPropagator(propagator);

  const sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    spanProcessor: new SimpleSpanProcessor(exporter),
    textMapPropagator: propagator,
    contextManager,
  });
  sdk.start();

  console.log(`[otel] Tracing started for ${SERVICE_NAME}`);
  return trace.getTracer(SERVICE_NAME);
}

export function getTracer() {
  return trace.getTracer(SERVICE_NAME);
}
