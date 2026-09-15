import { prisma } from "../lib/prisma.js";
import { createLogger } from "../lib/logger.js";
import { execute } from "./transaction.service.js";

// A PROCESSING transaction whose heartbeat predates this bound is presumed
// orphaned (worker crashed before completing). Mirrors the pre-existing
// POST /internal/recover cutoff.
export const STALE_AFTER_MS = 60_000;
// Poll period for the in-process scheduler: frequent enough to bound
// recovery latency, sparse enough to never resemble a tight loop.
export const RECOVERY_INTERVAL_MS = 60_000;
// First tick shortly after boot so a restarted service promptly recovers
// work orphaned by the crash, once migrations/connections are ready.
export const RECOVERY_STARTUP_DELAY_MS = 5_000;

const log = createLogger("recovery");

// Bounded (oldest first): a pathological backlog never blows up one tick;
// leftovers are picked up by later ticks in deterministic order.
export const RECOVERY_SCAN_LIMIT = 100;

export async function findStaleTransactions() {
  return prisma.transaction.findMany({
    where: {
      status: "PROCESSING",
      processingStartedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) },
    },
    orderBy: { processingStartedAt: "asc" },
    take: RECOVERY_SCAN_LIMIT,
  });
}

export async function recoverStaleTransactions(
  deps: {
    executeFn?: (tx: any) => Promise<unknown>;
  } = {},
) {
  const executeFn = deps.executeFn ?? execute;
  const xs = await findStaleTransactions();
  // Mutual exclusion lives inside execute(): a second concurrent executor
  // reports fresh state instead of duplicating side effects, so invoking
  // once per stale row here is always safe.
  for (const x of xs) await executeFn(x);
  return { recovered: xs.length };
}

export function startRecoveryScheduler(
  opts: { intervalMs?: number; startupDelayMs?: number } = {},
  deps: Parameters<typeof recoverStaleTransactions>[0] = {},
) {
  const intervalMs = opts.intervalMs ?? RECOVERY_INTERVAL_MS;
  const startupDelayMs = opts.startupDelayMs ?? RECOVERY_STARTUP_DELAY_MS;
  let stopped = false;
  let inFlight = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const { recovered } = await recoverStaleTransactions(deps);
      if (recovered > 0) log.info(`recovered ${recovered} stale transactions`);
    } catch (e: any) {
      // A failed tick must never kill the scheduler; the next tick retries.
      log.error("recovery tick failed", e);
    } finally {
      inFlight = false;
    }
  };

  const startup = setTimeout(() => {
    if (stopped) return;
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
  }, startupDelayMs);
  if (typeof (startup as any).unref === "function") (startup as any).unref();

  return () => {
    stopped = true;
    clearTimeout(startup);
    if (timer) clearInterval(timer);
  };
}
