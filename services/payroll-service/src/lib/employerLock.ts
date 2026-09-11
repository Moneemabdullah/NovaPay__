import crypto from "node:crypto";
import { Redis } from "ioredis";
import { envVars } from "../config/env.utils.js";

// BullMQ OSS has no per-key concurrency groups, so per-employer
// serialization is enforced with a Redis lease lock on the single shared
// queue: same employer -> second job defers; different employers -> proceed
// in parallel across worker slots.

export const EMPLOYER_LOCK_TTL_MS = 120_000;
export const EMPLOYER_LOCK_RETRY_DELAY_MS = 5_000;
export const WORKER_CONCURRENCY = 5;

export function employerLockKey(employerAccountId: string) {
  return `payroll:employer-lock:${employerAccountId}`;
}

export class EmployerLockBusyError extends Error {
  constructor(public readonly employerAccountId: string) {
    super(`payroll employer ${employerAccountId} is already being processed`);
    this.name = "EmployerLockBusyError";
  }
}

// Minimal surface the lock needs. Loose signatures keep both the real
// ioredis client and the in-memory test fake assignable without overload
// friction; call sites only ever use SET NX PX and the release script.
export type LockRedis = {
  set(key: string, value: string, ...args: any[]): Promise<any>;
  eval(script: string, numkeys: number, ...args: any[]): Promise<any>;
};

export async function acquireEmployerLock(
  redis: LockRedis,
  employerAccountId: string,
  token: string = crypto.randomUUID(),
  ttlMs: number = EMPLOYER_LOCK_TTL_MS,
): Promise<string | null> {
  const res = await redis.set(
    employerLockKey(employerAccountId),
    token,
    "PX",
    ttlMs,
    "NX",
  );
  return res === "OK" ? token : null;
}

// Ownership-safe release: only the token holder deletes the key, so a
// worker whose lease expired can never delete its successor's lock.
const RELEASE_SCRIPT = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

export async function releaseEmployerLock(
  redis: LockRedis,
  employerAccountId: string,
  token: string,
): Promise<boolean> {
  const res = await redis.eval(
    RELEASE_SCRIPT,
    1,
    employerLockKey(employerAccountId),
    token,
  );
  return res === 1;
}

export async function withEmployerLock<T>(
  redis: LockRedis,
  employerAccountId: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; token?: string } = {},
): Promise<T> {
  const token = opts.token ?? crypto.randomUUID();
  const acquired = await acquireEmployerLock(
    redis,
    employerAccountId,
    token,
    opts.ttlMs ?? EMPLOYER_LOCK_TTL_MS,
  );
  if (!acquired) throw new EmployerLockBusyError(employerAccountId);
  try {
    return await fn();
  } finally {
    await releaseEmployerLock(redis, employerAccountId, token);
  }
}

let shared: Redis | undefined;

export function lockRedis(): Redis {
  if (!shared) shared = new Redis(envVars.REDIS_URL);
  return shared;
}

export async function closeLockRedis(): Promise<void> {
  if (shared) {
    shared.disconnect();
    shared = undefined;
  }
}
