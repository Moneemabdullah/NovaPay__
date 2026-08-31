import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { trace } from "@opentelemetry/api";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://jaeger:4317";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "api-gateway";

let initialized = false;

export function initTracing() {
  if (initialized) return trace.getTracer(SERVICE_NAME);
  initialized = true;

  console.log(`[otel] Initializing tracing for ${SERVICE_NAME} -> ${OTEL_ENDPOINT}`);

  const exporter = new OTLPTraceExporter({ url: OTEL_ENDPOINT });

  const sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  sdk.start();

  const tracer = trace.getTracer(SERVICE_NAME);
  console.log(`[otel] Tracing started for ${SERVICE_NAME}, tracer type: ${tracer.constructor.name}`);
  return tracer;
}

export function getTracer() {
  return trace.getTracer(SERVICE_NAME);
}
