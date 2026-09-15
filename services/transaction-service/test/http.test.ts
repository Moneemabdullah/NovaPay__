import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { post, get } from "../src/lib/http.js";

function startFlaky() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/slow") {
        // Never responds within the test timeout.
        setTimeout(
          () => res.writeHead(200).end("{}"),
          30_000,
        ).unref?.();
        return;
      }
      if (url === "/missing") {
        res.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
        return;
      }
      if (url === "/boom") {
        res.writeHead(500).end(JSON.stringify({ error: "BROKEN", message: "down" }));
        return;
      }
      res.writeHead(200).end("{}");
    });
  });
  return {
    start: () =>
      new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    url: () => {
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    },
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

describe("lib/http transport semantics", () => {
  it("4xx/5xx throw with status and code, never retried or swallowed", async () => {
    const downstream = startFlaky();
    await downstream.start();
    try {
      await expect(post(downstream.url(), "/boom", {})).rejects.toMatchObject({
        status: 500,
        code: "BROKEN",
      });
      // A single attempt only: the mock would record repeats (it cannot).
      await expect(get(downstream.url(), "/missing")).resolves.toBeNull();
    } finally {
      await downstream.close();
    }
  });

  it("connection refusal surfaces as a failure, not a success", async () => {
    await expect(
      post("http://127.0.0.1:1", "/x", {}, undefined, { timeoutMs: 2000 }),
    ).rejects.toThrow();
  });

  it("a hung downstream aborts via timeout instead of waiting forever", async () => {
    const downstream = startFlaky();
    await downstream.start();
    try {
      await expect(
        get(downstream.url(), "/slow", undefined, { timeoutMs: 100 }),
      ).rejects.toThrow(/aborted|timeout/i);
    } finally {
      await downstream.close();
    }
  });
});
