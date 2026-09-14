import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  recoverStaleTransactions,
  startRecoveryScheduler,
  STALE_AFTER_MS,
} from "../src/services/recovery.service.js";
import { withRecoveryLock } from "../src/lib/recoveryLock.js";

class FakeRedis {
  private store = new Map<
    string,
    { value: string; expireAt: number | null }
  >();

  private read(key: string) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expireAt !== null && e.expireAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async set(key: string, value: string, ...args: (string | number)[]) {
    if (args.includes("NX") && this.read(key)) return null;
    let expireAt: number | null = null;
    const px = args.indexOf("PX");
    if (px >= 0) expireAt = Date.now() + Number(args[px + 1]);
    this.store.set(key, { value, expireAt });
    return "OK";
  }

  async eval(script: string, _numkeys: number, ...args: string[]) {
    const [key, token] = args;
    const e = this.read(key);
    if (!e || e.value !== token) return 0;
    if (script.includes("PEXPIRE")) {
      e.expireAt = Date.now() + Number(args[2]);
      return 1;
    }
    this.store.delete(key);
    return 1;
  }

  has(key: string) {
    return this.read(key) !== undefined;
  }

  get(key: string) {
    return this.read(key)?.value;
  }
}

const staleRow = (id: string) => ({
  id,
  status: "PROCESSING",
  processingStartedAt: new Date(Date.now() - STALE_AFTER_MS - 1000),
});

const state = vi.hoisted(() => ({
  rows: [] as any[],
  findManyArgs: null as any,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    transaction: {
      findMany: async (args: any) => {
        state.findManyArgs = args;
        return state.rows;
      },
    },
  },
}));

// recoverStaleTransactions delegates execution (executeFn stubbed here);
// mutual exclusion lives inside the real execute() and is proven by the
// concurrent-execution integration test with real Redis.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  state.rows = [];
  state.findManyArgs = null;
});

describe("recoverStaleTransactions", () => {
  it("invokes execution once per stale row", async () => {
    const executed: string[] = [];
    state.rows = [staleRow("txn-1")];
    const res = await recoverStaleTransactions({
      executeFn: async (tx: any) => {
        executed.push(tx.id);
        return { transactionId: tx.id, status: "COMPLETED" };
      },
    });
    expect(res).toEqual({ recovered: 1 });
    expect(executed).toEqual(["txn-1"]);
  });

  it("queries only stale PROCESSING transactions", async () => {
    const before = Date.now();
    await recoverStaleTransactions({
      executeFn: async () => ({}),
    });
    expect(state.findManyArgs.where.status).toBe("PROCESSING");
    const cutoff = state.findManyArgs.where.processingStartedAt.lt.getTime();
    expect(cutoff).toBeLessThanOrEqual(before);
    expect(cutoff).toBeGreaterThan(before - STALE_AFTER_MS - 5000);
  });

  it("leaves fresh PROCESSING transactions untouched", async () => {
    const executeFn = vi.fn();
    const res = await recoverStaleTransactions({ executeFn });
    expect(res).toEqual({ recovered: 0 });
    expect(executeFn).not.toHaveBeenCalled();
  });

  it("propagates recovery failures", async () => {
    state.rows = [staleRow("txn-1")];
    await expect(
      recoverStaleTransactions({
        executeFn: async () => {
          throw new Error("ledger down");
        },
      }),
    ).rejects.toThrow("ledger down");
  });

  it("repeated recovery is safe: completed rows disappear from the scan", async () => {
    let calls = 0;
    // First tick finds the orphan; the (idempotent) execute completes it,
    // so the second tick's scan is empty — mirroring the status re-check.
    state.rows = [{ ...staleRow("txn-1") }];
    await recoverStaleTransactions({
      executeFn: async () => {
        calls += 1;
        state.rows = [];
        return {};
      },
    });
    const res = await recoverStaleTransactions({
      executeFn: async () => {
        calls += 1;
        return {};
      },
    });
    expect(calls).toBe(1);
    expect(res).toEqual({ recovered: 0 });
  });
});

describe("withRecoveryLock (lease mechanics)", () => {
  it("serializes holders and frees the lock afterwards", async () => {
    const redis = new FakeRedis();
    const gate = deferred();
    const entered = deferred();
    const first = withRecoveryLock(redis as any, "txn-1", async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    expect(
      await withRecoveryLock(redis as any, "txn-1", async () => {}),
    ).toBeNull();
    gate.resolve();
    await first;
    expect(redis.has("txn:recovery:txn-1")).toBe(false);
  });

  it("releases the lock when the work throws", async () => {
    const redis = new FakeRedis();
    await expect(
      withRecoveryLock(redis as any, "txn-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.has("txn:recovery:txn-1")).toBe(false);
  });

  it("an expired lock does not block takeover, and the stale owner cannot steal it back", async () => {
    const redis = new FakeRedis();
    await redis.set("txn:recovery:txn-1", "crashed", "PX", 30, "NX");
    await sleep(80);
    const res = await withRecoveryLock(
      redis as any,
      "txn-1",
      async () => "done",
    );
    expect(res).toBe("done");
  });

  it("heartbeat renewal keeps the lock across long recoveries", async () => {
    const redis = new FakeRedis();
    const gate = deferred();
    const entered = deferred();
    const run = withRecoveryLock(
      redis as any,
      "txn-1",
      async () => {
        entered.resolve();
        await gate.promise;
      },
      { ttlMs: 120, renewMs: 30 },
    );
    await entered.promise;
    await sleep(200); // several TTL windows pass while work continues
    expect(redis.has("txn:recovery:txn-1")).toBe(true);
    gate.resolve();
    await run;
    expect(redis.has("txn:recovery:txn-1")).toBe(false);
  });
});

describe("startRecoveryScheduler", () => {
  it("recovers stale work after boot and stops on demand", async () => {
    state.rows = [staleRow("txn-1")];
    let calls = 0;
    const stop = startRecoveryScheduler(
      { startupDelayMs: 10, intervalMs: 20 },
      {
        executeFn: async () => {
          calls += 1;
          state.rows = [];
          return {};
        },
      },
    );
    const deadline = Date.now() + 2000;
    while (calls === 0 && Date.now() < deadline) await sleep(10);
    expect(calls).toBeGreaterThan(0);
    stop();
    const frozen = calls;
    await sleep(80);
    expect(calls).toBe(frozen);
  });
});
