import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerServiceAuth } from "../src/middlewares/service-auth.js";
import { envVars } from "../src/config/env.utils.js";

const GW = "test-gateway-token";
const PAY = "test-payroll-token";
const SELF = "test-transaction-token";

async function build() {
  const app = Fastify();
  registerServiceAuth(
    app,
    () => ({
      "api-gateway": envVars.PEER_API_GATEWAY_TOKEN,
      "payroll-service": envVars.PEER_PAYROLL_SERVICE_TOKEN,
      "transaction-service": envVars.SERVICE_TOKEN,
    }),
    {
      "api-gateway": [
        "POST /transactions",
        "POST /transfers*",
        "POST /international*",
        "GET /transactions*",
      ],
      "payroll-service": ["POST /transactions"],
      "transaction-service": ["POST /internal/*"],
    },
  );
  app.all("/*", async () => ({ ok: true }));
  return app;
}

const hdr = (id: string, token: string) => ({
  "x-service-id": id,
  "x-service-token": token,
});

beforeEach(() => {
  envVars.PEER_API_GATEWAY_TOKEN = GW;
  envVars.PEER_PAYROLL_SERVICE_TOKEN = PAY;
  envVars.SERVICE_TOKEN = SELF;
});

describe("service-auth middleware", () => {
  it("rejects requests without credentials (401)", async () => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: "/transactions" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("rejects unknown service identity (401, same shape)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: hdr("evil-service", "whatever"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid credential (401)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: hdr("api-gateway", "wrong-token"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts an allowed endpoint for the identity", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: hdr("payroll-service", PAY),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects an endpoint allowed only for another identity (403)", async () => {
    const app = await build();
    const forbidden = await app.inject({
      method: "POST",
      url: "/internal/recover",
      headers: hdr("payroll-service", PAY),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe("FORBIDDEN");
    const allowed = await app.inject({
      method: "POST",
      url: "/internal/recover",
      headers: hdr("transaction-service", SELF),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("gateway prefix rules do not leak /internal/*", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/transactions/internal/recover",
      headers: hdr("api-gateway", GW),
    });
    expect(res.statusCode).toBe(403);
  });

  it("leaves /health and /metrics open", async () => {
    const app = await build();
    for (const url of ["/health", "/metrics"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
    }
  });

  it("never echoes credentials in rejection bodies", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/transactions",
      headers: hdr("api-gateway", "super-secret-value"),
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("super-secret-value");
  });
});
