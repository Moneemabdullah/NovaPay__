import { describe, it, expect } from "vitest";
import {
  acquireEmployerLock,
  releaseEmployerLock,
  withEmployerLock,
  employerLockKey,
  EmployerLockBusyError,
  type LockRedis,
} from "../src/lib/employerLock.js";

// In-memory fake implementing the exact Redis semantics the lock relies
// on: SET ... NX PX, key expiry, and compare-and-delete release.
class FakeRedis implements LockRedis {
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

  async eval(_script: string, _numkeys: number, ...args: string[]) {
    const [key, token] = args;
    const e = this.read(key);
    if (e && e.value === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  has(key: string) {
    return this.read(key) !== undefined;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("employer lease lock", () => {
  it("second holder for the SAME employer fails while the first holds the lock", async () => {
    const redis = new FakeRedis();
    const gate = deferred();
    const entered = deferred();
    const first = withEmployerLock(redis, "emp-1", async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise; // first definitely holds the lock
    await expect(
      withEmployerLock(redis, "emp-1", async () => {}),
    ).rejects.toBeInstanceOf(EmployerLockBusyError);
    gate.resolve();
    await first;
    // After release the next job proceeds.
    let ran = false;
    await withEmployerLock(redis, "emp-1", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("DIFFERENT employers hold their locks concurrently", async () => {
    const redis = new FakeRedis();
    let current = 0;
    let max = 0;
    const gate = deferred();
    const work = async () => {
      current += 1;
      max = Math.max(max, current);
      await gate.promise;
      current -= 1;
    };
    const both = Promise.all([
      withEmployerLock(redis, "emp-A", work),
      withEmployerLock(redis, "emp-B", work),
    ]);
    const deadline = Date.now() + 2_000;
    while (current < 2 && Date.now() < deadline) await sleep(5);
    expect(current).toBe(2);
    gate.resolve();
    await both;
    expect(max).toBe(2);
  });

  it("releases the lock after successful processing", async () => {
    const redis = new FakeRedis();
    await withEmployerLock(redis, "emp-1", async () => {});
    expect(redis.has(employerLockKey("emp-1"))).toBe(false);
  });

  it("releases the lock when processing throws, and propagates the error", async () => {
    const redis = new FakeRedis();
    await expect(
      withEmployerLock(redis, "emp-1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(redis.has(employerLockKey("emp-1"))).toBe(false);
  });

  it("a non-owner release fails and keeps the lock", async () => {
    const redis = new FakeRedis();
    const token = await acquireEmployerLock(redis, "emp-1", "owner");
    expect(token).toBe("owner");
    expect(await releaseEmployerLock(redis, "emp-1", "intruder")).toBe(false);
    expect(redis.has(employerLockKey("emp-1"))).toBe(true);
    expect(await releaseEmployerLock(redis, "emp-1", "owner")).toBe(true);
  });

  it("an expired lock cannot block an employer, and the stale owner cannot steal the successor lock", async () => {
    const redis = new FakeRedis();
    const stale = await acquireEmployerLock(redis, "emp-1", "stale", 30);
    expect(stale).toBe("stale");
    await sleep(80); // lease expires (simulates a crashed worker)
    const fresh = await acquireEmployerLock(redis, "emp-1", "fresh", 60_000);
    expect(fresh).toBe("fresh");
    // Stale owner's release is a no-op: successor keeps its lock.
    expect(await releaseEmployerLock(redis, "emp-1", "stale")).toBe(false);
    expect(redis.has(employerLockKey("emp-1"))).toBe(true);
    expect(await releaseEmployerLock(redis, "emp-1", "fresh")).toBe(true);
  });
});
