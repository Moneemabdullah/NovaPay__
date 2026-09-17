// NovaPay lightweight load test (zero dependencies, Node 20+).
//
// Safety: defaults to a read-only baseline (GET /docs/json through the
// gateway). Write endpoints require explicit WRITE=1 and use isolated
// `loadtest-` idempotency keys so runs can never look like real activity.
//
// Usage:
//   node scripts/load/load-test.mjs [options]
//   make load-test [URL=...] [RATE=...] [DURATION=...] [CONCURRENCY=...]
//
// Options (env or --flag):
//   URL          target URL (default http://localhost:8080/docs/json)
//   METHOD       GET (default) or POST
//   BODY         JSON string body for POST (default {})
//   HEADERS      JSON string of extra headers (default {})
//   WRITE=1      required to allow non-GET methods
//   RATE         target requests/sec, 0 = as fast as possible (default 20)
//   DURATION     seconds to run (default 30)
//   CONCURRENCY  max in-flight requests (default 10)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1].toUpperCase(), m[2]] : [];
  }),
);
const env = (k, d) => args[k] ?? process.env[k] ?? d;

const URL = env("URL", "http://localhost:8080/docs/json");
const METHOD = env("METHOD", "GET").toUpperCase();
const BODY = env("BODY", "{}");
const HEADERS = JSON.parse(env("HEADERS", "{}"));
const RATE = Number(env("RATE", "20"));
const DURATION = Number(env("DURATION", "30"));
const CONCURRENCY = Number(env("CONCURRENCY", "10"));
// Optional per-request idempotency header for write endpoints:
// IDEMPOTENCY_PREFIX=loadtest-20240101 sends Idempotency-Key: <prefix><i>.
const IDEMPOTENCY_PREFIX = env("IDEMPOTENCY_PREFIX", "");

if (METHOD !== "GET" && env("WRITE", "0") !== "1") {
  console.error("Refusing non-GET method without WRITE=1 (safety).");
  process.exit(2);
}
if (!(RATE >= 0) || !(DURATION > 0) || !(CONCURRENCY > 0)) {
  console.error("RATE/DURATION/CONCURRENCY must be positive numbers.");
  process.exit(2);
}

const latencies = [];
let ok = 0;
let failed = 0;
const errors = new Map();

async function one(i) {
  const start = performance.now();
  try {
    const idem = IDEMPOTENCY_PREFIX ? { "Idempotency-Key": `${IDEMPOTENCY_PREFIX}${i}` } : {};
    const res = await fetch(URL, {
      method: METHOD,
      headers: { "content-type": "application/json", ...HEADERS, ...idem },
      body: METHOD === "GET" ? undefined : BODY.replaceAll("{i}", String(i)),
      signal: AbortSignal.timeout(15000),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) ok += 1;
    else {
      failed += 1;
      errors.set(res.status, (errors.get(res.status) ?? 0) + 1);
    }
  } catch (e) {
    failed += 1;
    const k = e?.name ?? "fetch-error";
    errors.set(k, (errors.get(k) ?? 0) + 1);
  } finally {
    latencies.push(performance.now() - start);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const t0 = Date.now();
const end = t0 + DURATION * 1000;
let sent = 0;
const inFlight = new Set();
const interval = RATE > 0 ? 1000 / RATE : 0;
let nextDue = Date.now();

while (Date.now() < end) {
  if (RATE > 0) {
    const wait = nextDue - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextDue += interval;
    if (nextDue < Date.now() - 1000) nextDue = Date.now(); // don't spiral on lag
  }
  while (inFlight.size >= CONCURRENCY) {
    await Promise.race(inFlight);
  }
  if (Date.now() >= end) break;
  const p = one(sent++).finally(() => {});
  inFlight.add(p);
  p.then(() => inFlight.delete(p));
}
await Promise.allSettled(inFlight);

const total = ok + failed;
const secs = (Date.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const summary = {
  target: `${METHOD} ${URL}`,
  duration_s: Number(secs.toFixed(1)),
  total_requests: total,
  successful: ok,
  failed,
  error_rate_pct: total ? Number(((failed / total) * 100).toFixed(2)) : 0,
  requests_per_sec: Number((total / secs).toFixed(1)),
  latency_ms: {
    avg: Number((latencies.reduce((a, b) => a + b, 0) / (total || 1)).toFixed(1)),
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
  },
  errors: Object.fromEntries(errors),
};
console.log(JSON.stringify(summary, null, 2));
