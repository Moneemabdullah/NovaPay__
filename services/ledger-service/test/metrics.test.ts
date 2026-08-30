import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { ledgerInvariantViolations } from "../src/lib/metrics.js";

describe("prometheus metrics", () => {
  it("exposes http latencies, process metrics, and invariant-violation counter", async () => {
    const app = await buildApp();
    await app.inject({ url: "/health" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_request_duration_seconds_bucket");
    expect(res.body).toContain(`ledger_invariant_violations_total{service="ledger-service"} 0`);
    expect(res.body).toContain("process_start_time_seconds");
  });

  it("drives ledger_invariant_violations_total from the real counter", async () => {
    const app = await buildApp();
    ledgerInvariantViolations.inc();
    const res = await app.inject({ url: "/metrics" });
    expect(res.body).toContain(`ledger_invariant_violations_total{service="ledger-service"} 1`);
  });
});