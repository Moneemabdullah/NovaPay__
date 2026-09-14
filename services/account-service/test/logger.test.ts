import { describe, it, expect, beforeAll } from "vitest";
import { context, trace } from "@opentelemetry/api";
// Same manager production enables in lib/otel.ts (hoisted transitive dep,
// test-only use): the API's default NoopContextManager does not propagate.
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { withContext } from "../src/lib/context.js";
import { REDACT_PATHS, createLogger, logBase } from "../src/lib/logger.js";

beforeAll(() => {
  context.setGlobalContextManager(new AsyncHooksContextManager().enable());
});

// The security contract Fastify bootstraps rely on: app.ts wires these
// exact paths into the framework logger so secrets/PII never reach
// access or error logs.
describe("structured logger contract", () => {
  it("redacts credentials, tokens, keys, and wrapped DEKs", () => {
    for (const p of [
      "password",
      "token",
      "secret",
      "authorization",
      "apiKey",
      "kek",
      "dek",
      "dekWrapped",
      "FIELD_ENCRYPTION_KEK",
    ])
      expect(REDACT_PATHS).toContain(p);
  });

  it("createLogger exposes level methods with module context", () => {
    const log = createLogger("test");
    for (const level of ["debug", "info", "warn", "error"] as const)
      expect(typeof log[level]).toBe("function");
  });

  it("carries the ALS requestId without inventing trace fields", () => {
    withContext({ requestId: "req-123" }, () => {
      expect(logBase("m")).toMatchObject({
        module: "m",
        requestId: "req-123",
      });
      expect(logBase("m")).not.toHaveProperty("trace_id");
    });
  });

  it("adds trace_id/span_id only when a valid span is active", async () => {
    const spanContext = {
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    };
    const active = trace.setSpanContext(context.active(), spanContext);
    await context.with(active, async () => {
      expect(logBase("m")).toMatchObject({
        trace_id: "a".repeat(32),
        span_id: "b".repeat(16),
      });
    });
    expect(logBase("m")).not.toHaveProperty("trace_id");
  });
});
