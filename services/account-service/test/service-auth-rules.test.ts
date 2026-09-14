import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

const TXN = "test-txn-token";
const GW = "test-gateway-token";

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_TRANSACTION_SERVICE_TOKEN = TXN;
  envVars.PEER_API_GATEWAY_TOKEN = GW;
});

describe("account-service authorization", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/wallets/w1/operations",
      payload: { operationKey: "k", deltaCents: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts transaction-service and gateway identities (400 validation proves acceptance, no DB hit)", async () => {
    const app = await buildApp();
    for (const [id, token] of [
      ["transaction-service", TXN],
      ["api-gateway", GW],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/wallets/w1/operations",
        headers: hdr(id, token),
        payload: { operationKey: "k" }, // missing deltaCents -> 400, pre-DB
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects unknown identity and wrong token (401)", async () => {
    const app = await buildApp();
    for (const [id, token] of [
      ["nope", "whatever"],
      ["transaction-service", "wrong"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: "/wallets/w1/operations",
        headers: hdr(id, token),
        payload: { operationKey: "k", deltaCents: 1 },
      });
      expect(res.statusCode).toBe(401);
    }
  });
});
