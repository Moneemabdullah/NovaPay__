import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

const TXN = "test-txn-token";
const GW = "test-gateway-token";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRaw: async () => [
      {
        id: "q1",
        rate: { toString: () => "0.92" },
        base_currency: "USD",
        quote_currency: "EUR",
      },
    ],
  },
}));

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_TRANSACTION_SERVICE_TOKEN = TXN;
  envVars.PEER_API_GATEWAY_TOKEN = GW;
});

describe("fx-service authorization", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/quote/q1" });
    expect(res.statusCode).toBe(401);
  });

  it("lets transaction-service consume quotes", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/quote/q1/consume",
      headers: hdr("transaction-service", TXN),
      payload: { transactionId: crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(200);
  });

  it("forbids gateway from consuming quotes (403)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/quote/q1/consume",
      headers: hdr("api-gateway", GW),
      payload: { transactionId: crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lets gateway request and read quotes", async () => {
    const app = await buildApp();
    const bad = await app.inject({
      method: "POST",
      url: "/quote",
      headers: hdr("api-gateway", GW),
      payload: { baseCurrency: "USD" }, // incomplete -> 400, pre-DB
    });
    expect(bad.statusCode).toBe(400);
  });
});
