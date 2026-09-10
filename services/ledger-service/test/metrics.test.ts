import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
import { ledgerInvariantViolations } from "../src/lib/metrics.js";
import { validateBatch } from "../src/services/ledger.service.js";

async function counterValue() {
  const metric = (await ledgerInvariantViolations.get()) as unknown as {
    values?: { value: number }[];
  };
  return metric.values?.[0]?.value ?? 0;
}

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

  it("increments ledger_invariant_violations_total exactly once per unbalanced batch", async () => {
    const before = await counterValue();
    const result = validateBatch("txn-unbalanced-1", [
      { accountId: "a1", direction: "debit", amountCents: 100, currency: "USD" },
      { accountId: "a2", direction: "credit", amountCents: 90, currency: "USD" },
    ]);
    expect(result).toMatchObject({
      status: 422,
      error: "UNBALANCED_LEDGER_TRANSACTION",
    });
    expect(await counterValue()).toBe(before + 1);

    // Balanced batches and 400-level validation errors must not touch the counter.
    const balanced = validateBatch("txn-balanced-1", [
      { accountId: "a1", direction: "debit", amountCents: 100, currency: "USD" },
      { accountId: "a2", direction: "credit", amountCents: 100, currency: "USD" },
    ]);
    expect(balanced).toBeNull();
    const invalid = validateBatch(undefined, []);
    expect(invalid?.status).toBe(400);
    expect(await counterValue()).toBe(before + 1);
  });
});