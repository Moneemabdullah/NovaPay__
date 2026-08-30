import { describe, it, expect, vi, afterEach } from "vitest";
import { pino } from "pino";
import { buildApp } from "../src/app.js";
import { logger, loggerOptions, createLogger } from "../src/lib/logger.js";
import { withContext, setContext } from "../src/lib/context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured logging context", () => {
  it("attaches requestId from ALS context to every log record", async () => {
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => logger as never);
    const errorSpy = vi
      .spyOn(logger, "error")
      .mockImplementation(() => logger as never);

    await withContext({ requestId: "req-123" }, async () => {
      createLogger("unit").info("hello", { field: 1 });
      createLogger("unit").error("boom", new Error("x"));
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-123", module: "unit" }),
      "hello",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-123", module: "unit" }),
      "boom",
    );
  });

  it("propagates the request's own requestId into handler log lines", async () => {
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => logger as never);
    const app = await buildApp();
    app.addHook("onRequest", async () => {
      createLogger("reqlog").info("inside request");
    });
    const res = await app.inject({
      url: "/health",
      headers: { "x-request-id": "req-injected" },
    });
    await app.close();

    expect(res.headers["x-request-id"]).toBe("req-injected");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-injected", module: "reqlog" }),
      "inside request",
    );
  });

  it("round-trips setContext fields into log records", async () => {
    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => logger as never);

    await withContext({ requestId: "req-456" }, async () => {
      setContext({ userId: "user-9", transactionId: "tx-7" });
      createLogger("unit").info("done");
    });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-456",
        userId: "user-9",
        transactionId: "tx-7",
      }),
      "done",
    );
  });

  it("redacts secret-shaped fields (incl. the KEK env value) before output", () => {
    let captured = "";
    const sink = { write: (chunk: string) => void (captured += chunk) };
    const l = pino(loggerOptions(), sink);
    l.info(
      {
        FIELD_ENCRYPTION_KEK: "super-secret-kek-value",
        password: "hunter2",
        nested: { dekWrapped: "wrapped-dek", token: "tok-1" },
        safe: "keep-me",
      },
      "redact check",
    );
    expect(captured).not.toContain("super-secret-kek-value");
    expect(captured).not.toContain("hunter2");
    expect(captured).not.toContain("wrapped-dek");
    expect(captured).not.toContain("tok-1");
    expect(captured).toContain("[REDACTED]");
    expect(captured).toContain("keep-me");
  });
});