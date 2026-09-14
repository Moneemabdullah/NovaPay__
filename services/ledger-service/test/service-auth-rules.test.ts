import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

const TXN = "test-txn-token";
const ADM = "test-admin-token";
const GW = "test-gateway-token";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: async () => [],
  },
}));

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_TRANSACTION_SERVICE_TOKEN = TXN;
  envVars.PEER_ADMIN_SERVICE_TOKEN = ADM;
  envVars.PEER_API_GATEWAY_TOKEN = GW;
});

describe("ledger-service authorization", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/invariant-check" });
    expect(res.statusCode).toBe(401);
  });

  it("lets transaction-service post batches (400 validation proves acceptance)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/batches",
      headers: hdr("transaction-service", TXN),
      payload: { transactionId: "x" }, // invalid batch -> 400, pre-DB
    });
    expect(res.statusCode).toBe(400);
  });

  it("forbids gateway and admin from posting batches (403)", async () => {
    const app = await buildApp();
    for (const [id, token] of [
      ["api-gateway", GW],
      ["admin-service", ADM],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/batches",
        headers: hdr(id, token),
        payload: { transactionId: "x", entries: [] },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("lets admin and gateway read invariant checks", async () => {
    const app = await buildApp();
    for (const [id, token] of [
      ["admin-service", ADM],
      ["api-gateway", GW],
    ] as const) {
      const res = await app.inject({
        method: "GET",
        url: "/invariant-check",
        headers: hdr(id, token),
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
