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

  it("counts rejected transfers as attempted and failed", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      payload: { amountCents: 100 },
    });
    expect(res.statusCode).toBe(400);
    const m = await app.inject({ url: "/metrics" });
    expect(m.body).toContain(
      'transactions_total{service="transaction-service",type="domestic"} 1',
    );
    expect(m.body).toContain(
      'transactions_failed_total{service="transaction-service",type="domestic"} 1',
    );
  });
});