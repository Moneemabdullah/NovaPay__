import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { envVars } from "../src/config/env.utils.js";

const GW = "test-gateway-token";

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_API_GATEWAY_TOKEN = GW;
});

describe("admin-service authorization", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      payload: { adminUser: "a", note: "n" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts gateway identity (400 validation proves acceptance)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      headers: hdr("api-gateway", GW),
      payload: { adminUser: "a" }, // missing note -> 400, pre-DB
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown service identity (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/incidents",
      headers: hdr("transaction-service", "whatever"),
      payload: { adminUser: "a", note: "n" },
    });
    expect(res.statusCode).toBe(401);
  });
});
