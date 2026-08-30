import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

describe("prometheus metrics", () => {
  it("exposes http latencies, process metrics, and fx provider failures", async () => {
    const app = await buildApp();
    await app.inject({ url: "/health" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_request_duration_seconds_bucket");
    expect(res.body).toContain(`fx_provider_failures_total{service="fx-service"} 0`);
    expect(res.body).toContain("process_start_time_seconds");
  });

  it("increments fx_provider_failures_total when the provider is unavailable", async () => {
    const app = await buildApp();
    const original = envVars.FX_PROVIDER_DOWN;
    try {
      envVars.FX_PROVIDER_DOWN = true;
      const quote = await app.inject({
        method: "POST",
        url: "/quote",
        payload: { baseCurrency: "USD", quoteCurrency: "EUR" },
      });
      expect(quote.statusCode).toBe(503);
    } finally {
      envVars.FX_PROVIDER_DOWN = original;
    }
    const res = await app.inject({ url: "/metrics" });
    expect(res.body).toContain(`fx_provider_failures_total{service="fx-service"} 1`);
  });
});