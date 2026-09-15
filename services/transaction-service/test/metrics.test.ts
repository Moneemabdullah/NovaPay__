import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

describe("prometheus metrics", () => {
  it("exposes http latencies, process metrics, and transaction counters", async () => {
    const app = await buildApp();
    await app.inject({ url: "/health" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_request_duration_seconds_bucket");
    expect(res.body).toContain("# HELP transactions_total");
    expect(res.body).toContain("# TYPE transactions_total counter");
    expect(res.body).toContain("process_start_time_seconds");
  });

  it("missing body normalizes to the route's own 400 (never a 500 TypeError)", async () => {
    const app = await buildApp();
    const { envVars } = await import("../src/config/env.utils.js");
    envVars.PEER_API_GATEWAY_TOKEN = "test-gateway-token";
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: {
        "x-service-id": "api-gateway",
        "x-service-token": "test-gateway-token",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("counts rejected transfers as attempted and failed", async () => {
    const app = await buildApp();
    const { envVars } = await import("../src/config/env.utils.js");
    envVars.PEER_API_GATEWAY_TOKEN = "test-gateway-token";
    const metricValue = async (name: string) => {
      const m = await app.inject({ url: "/metrics" });
      const match = m.body.match(
        new RegExp(`${name}\\{[^}]*\\} (\\d+(?:\\.\\d+)?)`),
      );
      return match ? Number(match[1]) : 0;
    };
    // Baseline first: earlier tests in this file also POST, and the
    // registry is process-global — assert the delta, not the absolute.
    const attemptedBefore = await metricValue("transactions_total");
    const failedBefore = await metricValue("transactions_failed_total");
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: {
        "x-service-id": "api-gateway",
        "x-service-token": "test-gateway-token",
      },
      payload: { amountCents: 100 },
    });
    expect(res.statusCode).toBe(400);
    expect(await metricValue("transactions_total")).toBe(attemptedBefore + 1);
    expect(await metricValue("transactions_failed_total")).toBe(failedBefore + 1);
  });
});