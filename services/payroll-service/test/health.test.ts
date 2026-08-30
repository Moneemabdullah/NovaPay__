import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";
describe("health", () => {
  it("reports service health", async () => {
    const app = await buildApp();
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });
});
