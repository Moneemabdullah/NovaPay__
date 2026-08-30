import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app.js";

describe("prometheus metrics", () => {
  it("exposes http latencies and process metrics at /metrics", async () => {
    const app = await buildApp();
    await app.inject({ url: "/health" });
    const res = await app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toContain("http_request_duration_seconds_bucket");
    expect(res.body).toContain('route="/health"');
    expect(res.body).toContain('status="200"');
    expect(res.body).toContain("process_start_time_seconds");
  });
});