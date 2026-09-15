import crypto from "node:crypto";
import { Redis } from "ioredis";
import { envVars } from "../config/env.utils.js";

// Ownership-safe distributed lock for the recovery scheduler, following the
// established Redis pattern: SET key unique-token NX PX ttl. Release and
// renewal are atomic Lua scripts that only act when the stored token still
// equals the owner's token — a worker that outlives its TTL can never
// delete or extend a lock acquired by another worker.
export const RECOVERY_LOCK_TTL_MS = 300_000;
export const RECOVERY_LOCK_RENEW_MS = 60_000;

// Minimal surface the lock needs. Structurally satisfied by ioredis;
// unit tests inject an in-memory fake implementing the same contract.
export type LockRedis = {
  set(key: string, value: string, ...args: any[]): Promise<any>;
  eval(script: string, numkeys: number, ...args: any[]): Promise<any>;
};

export function recoveryLockKey(transactionId: string) {
  return `txn:recovery:${transactionId}`;
}

// Thrown only for Redis connectivity failures during lock acquisition —
// never for business errors from the protected function (those propagate
// untouched) and never for contention (which returns null).
export class RecoveryLockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as any);
    this.name = "RecoveryLockError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Bounded readiness wait: a freshly created client may still be
// connecting (first command would otherwise reject instantly with
// offlineQueue disabled). Steady-state cost is zero (status check only);
// prolonged outage resolves false so the caller can fail open.
export async function ensureRedis(
  redis: LockRedis & { status?: unknown; ping?: () => Promise<unknown> },
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    if ((redis as any)?.status === "ready") return true;
    const ping = (redis as any)?.ping;
    if (typeof ping !== "function") return true;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await ping.call(redis);
        return true;
      } catch {
        if (Date.now() >= deadline) return false;
        await sleep(50);
      }
    }
  } catch {
    return false;
  }
}

export async function acquireRecoveryLock(
  redis: LockRedis,
  transactionId: string,
  token: string = crypto.randomUUID(),
  ttlMs: number = RECOVERY_LOCK_TTL_MS,
): Promise<string | null> {
  const res = await redis.set(
    recoveryLockKey(transactionId),
    token,
    "PX",
    ttlMs,
    "NX",
  );
  return res === "OK" ? token : null;
}

const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

export async function releaseRecoveryLock(
  redis: LockRedis,
  transactionId: string,
  token: string,
): Promise<boolean> {
  const res = await redis.eval(
    RELEASE_SCRIPT,
    1,
    recoveryLockKey(transactionId),
    token,
  );
  return res === 1;
}

const RENEW_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

export async function renewRecoveryLock(
  redis: LockRedis,
  transactionId: string,
  token: string,
  ttlMs: number = RECOVERY_LOCK_TTL_MS,
): Promise<boolean> {
  const res = await redis.eval(
    RENEW_SCRIPT,
    1,
    recoveryLockKey(transactionId),
    token,
    String(ttlMs),
  );
  return res === 1;
}

// Runs fn holding the lease, renewing it on a heartbeat so arbitrarily long
// recoveries stay exclusive. Returns null when another worker holds the
// lease (caller skips — never busy-waits). Always releases in `finally`.
export async function withRecoveryLock<T>(
  redis: LockRedis,
  transactionId: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; renewMs?: number; token?: string } = {},
): Promise<T | null> {
  const ttlMs = opts.ttlMs ?? RECOVERY_LOCK_TTL_MS;
  const renewMs = opts.renewMs ?? RECOVERY_LOCK_RENEW_MS;
  const token = opts.token ?? crypto.randomUUID();
  let acquired: string | null;
  try {
    acquired = await acquireRecoveryLock(redis, transactionId, token, ttlMs);
  } catch (e) {
    throw new RecoveryLockError("recovery lock acquisition failed", {
      cause: e,
    });
  }
  if (!acquired) return null;
  const heartbeat = setInterval(() => {
    renewRecoveryLock(redis, transactionId, token, ttlMs).catch(() => undefined);
  }, renewMs);
  if (typeof (heartbeat as any).unref === "function") (heartbeat as any).unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseRecoveryLock(redis, transactionId, token).catch(
      () => undefined,
    );
  }
}

let shared: Redis | undefined;

export function lockRedis(): Redis {
  // enableOfflineQueue: false is load-bearing: when Redis is unreachable,
  // lock commands must reject immediately (driving the fail-open path in
  // execute()) instead of buffering forever behind a hung connection.
  // The error listener prevents unhandled 'error' events from crashing
  // long-lived processes on connection drops; command failures still
  // reject to their callers normally.
  if (!shared) {
    shared = new Redis(envVars.REDIS_URL, {
      enableOfflineQueue: false,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
    });
    shared.on("error", () => undefined);
  }
  return shared;
}

export async function closeLockRedis(): Promise<void> {
  if (shared) {
    shared.disconnect();
    shared = undefined;
  }
}
