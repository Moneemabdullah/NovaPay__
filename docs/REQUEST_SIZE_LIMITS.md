# NovaPay — Request Size Limits (Nginx vs Application Validation)

## Problem

Large legitimate `POST /payroll/jobs` batches (JSON body with `items[]`)
were rejected with **HTTP 413** before ever reaching the application.
`infra/nginx/default.conf` set `client_max_body_size 64k`, so any payroll
batch whose JSON exceeded 64 KB died at the reverse proxy.

## Why 64 KB Was Insufficient

A payroll item serializes to roughly 75 bytes
(`{"recipientWalletId":"<uuid>","amountCents":<n>}`), so 64 KB caps a batch
at ~850 items. Real payroll runs (hundreds to thousands of recipients)
legitimately exceed that. The 64k value was a conservative default, not a
deliberate product constraint — no business rule ever limited batch size.

## Where the Request Was Rejected

```
client ──POST /payroll/jobs (200 KB)──▶ nginx ──413──▶ client
                                        (never proxied)
```

Nginx enforces `client_max_body_size` while reading the request body, before
`proxy_pass`. The api-gateway, payroll-service validation, and all
downstream services never saw the request — no trace, no log, no metric
beyond the 413.

## Infrastructure Protection vs Application Validation

These are two separate layers with different jobs:

| Layer | Mechanism | Purpose |
|---|---|---|
| Nginx (`client_max_body_size 10m`) | Reject absurdly large bodies at the edge | Cheap abuse/DoS protection for every route |
| Fastify (1 MB default body limit) | Framework-level cap per request | Second line of defense inside each service |
| Payroll route (`MAX_PAYROLL_ITEMS = 5000`) | Business-shaped bound (~0.4 MB worst case) | Keep single-batch DB/queue work bounded; clear 400 error |

A limit at one layer must never silently contradict another: each inner
layer is stricter and returns a more specific error than the outer one.

## New Request Flow

```
                        ┌── > 10 MB ──────────────▶ 413 from nginx
                        │
client ──POST /jobs──▶ nginx ── ≤ 10 MB ──▶ api-gateway ──▶ payroll-service
                                                                      │
                                              ┌── > 5000 items ──▶ 400 VALIDATION_ERROR
                                              │
                                              └── ≤ 5000 items ──▶ 202 queued
```

## Chosen Limit and Why

- **Nginx: `10m`.** Admits the largest realistic JSON batches (~MBs) with
  headroom, while still bounding memory/CPU spent reading bodies at the
  edge. Not removed: an unbounded edge invites trivial body-based DoS.
- **Payroll cap: 5000 items.** An operational guard (not a pricing rule):
  5000 typical items ≈ 0.4 MB, comfortably under Fastify's 1 MB default,
  10× the largest batch covered by integration tests (500 items).

## Failure Behavior

| Condition | Status | Body | Source |
|---|---|---|---|
| Body > 10 MB | 413 | Nginx default error page | nginx |
| Body ≤ 10 MB but > 1 MB | 413 | Fastify body-limit error | framework |
| `items.length` > 5000 | 400 `VALIDATION_ERROR` | `{"error":"VALIDATION_ERROR",...}` | payroll route |
| Missing employer / empty / invalid item | 400 `VALIDATION_ERROR` | unchanged | payroll route (pre-existing) |

## Security / Scalability Considerations

- 10 MB at the edge is per-request and connection-bounded; nginx still
  rejects chunked/gzip-bomb-style abuse above the cap before proxying.
- The 5000-item cap bounds `createMany` row counts, BullMQ payload size,
  and worst-case worker loop iterations per job.
- Per-item validation (recipient present, positive safe-integer cents) is
  unchanged and still runs before any DB write.

## Tradeoffs

- A fixed item cap is mildly arbitrary, but it is documented, tested, and
  far above demonstrated needs; raising it later is a one-constant change.
- Bodies between 1 MB and 10 MB pass nginx but hit Fastify's default 1 MB
  cap — acceptable overlap, and the Fastify error is explicit.

## Future Option

If payroll batches ever need to exceed single-request practicality (tens of
thousands of recipients), move to object-storage/file-reference uploads:
client uploads a CSV/JSON file, then posts a job referencing the file key,
and the worker streams it. No change needed today.
