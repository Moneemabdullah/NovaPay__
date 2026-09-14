import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

const GW = "test-gateway-token";
const TXN = "test-txn-token";

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_API_GATEWAY_TOKEN = GW;
});

describe("payroll-service authorization", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { employerAccountId: "e", items: [] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts gateway identity (400 validation proves acceptance)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: hdr("api-gateway", GW),
      payload: { employerAccountId: "e", items: [] }, // empty -> 400, pre-DB
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects identities outside payroll's peer map (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: hdr("transaction-service", TXN),
      payload: { employerAccountId: "e", items: [{ recipientWalletId: "w", amountCents: 1 }] },
    });
    // transaction-service is not a known peer of payroll -> 401.
    expect(res.statusCode).toBe(401);
  });
});
