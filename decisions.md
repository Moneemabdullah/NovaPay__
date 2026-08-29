# Design Decisions

This file documents the reasoning behind the harder design calls in this
system, per the assessment's requirements. Fill in the `[TODO]` sections as
each piece is implemented in full (current repo state is a scaffold with
partial/stub logic — see each service's inline comments for exactly what's
stubbed vs real).

## Problem 1 — Idempotent Disbursement

### Scenario A: Same key arrives twice
[TODO expand] Mechanism implemented in `transaction-service/src/index.js`:
the idempotency key is the primary key of `idempotency_keys`. A duplicate
request with a `status = 'completed'` row replays the cached
`response_body` and never re-enters the debit/credit path.

### Scenario B: Three identical requests within 100ms
[TODO expand] All three attempt `INSERT INTO idempotency_keys (key, ...)`.
Postgres's UNIQUE constraint on `key` allows exactly one INSERT to succeed;
the other two get a `23505 unique_violation` at the database level and are
routed to `handleExistingKey`, which either replays the winner's response or
returns `202 processing` if the winner hasn't finished yet. The two losing
requests never write a transaction or ledger row — the race is resolved by
Postgres's own uniqueness enforcement, not application-level locking.

### Scenario C: Crash between debit and credit (atomicity)
[TODO — not yet implemented in this scaffold]
Planned approach: the transaction row moves `pending -> debited -> completed`
as explicit states. A reaper/reconciliation job periodically scans for
transactions stuck in `debited` older than a short threshold (e.g. 30s) and
either (a) completes the credit if the ledger batch shows only the debit
leg was written, or (b) reverses the debit with a compensating ledger entry.
The two-phase status update, plus the ledger's own all-or-nothing batch
INSERT (single DB transaction wrapping both entries — see
`ledger-service/src/index.js`), together prevent a permanently unbalanced
ledger.

### Scenario D: Key expires after 24h, retried at 30h
Implemented: `handleExistingKey` checks `expires_at`. An expired key returns
`410 Gone` with an explicit message that the request will be treated as new
on resubmission — it is never silently replayed and never silently
reprocessed as a duplicate.

### Scenario E: Same key, different payload
Implemented: the request body is hashed (`sha256`) and stored alongside the
key. A second request with the same key but a different hash returns
`422 Unprocessable Entity` — it is rejected outright, not merged or
overwritten.

## Problem 2 — Bulk Payroll Queue Design

[TODO expand — reasoning currently lives as inline comments in
`payroll-service/src/index.js` and `worker.js`]

Summary: one BullMQ queue per employer account, one Worker per queue at
`concurrency: 1`. This serializes writes against a single employer's funding
account without a global lock (which would serialize unrelated employers)
or a long-held DB row lock (which would create severe contention across
14,000 sequential debits and reintroduce the kind of race that caused the
original incident).

## Problem 3 — FX Rate Locking

[TODO expand] `fx-service` issues quotes with a 60s TTL
(`fx_quotes.expires_at`). Consumption is atomic:
`UPDATE ... WHERE used = false AND expires_at > now()` in a single
statement, so a quote cannot be used twice even under concurrent attempts —
whichever request's UPDATE matches zero rows gets `409 quote_expired_or_already_used`.
Provider outage returns `503 fx_provider_unavailable` and never falls back
to a cached rate.

## Problem 4 — Field-Level Encryption

[TODO — schema has placeholders (`full_name_enc`, `dek_wrapped` in
`account-service/db/schema.sql`) but the encryption/decryption utility
itself is not yet implemented in this scaffold.]

Planned: envelope encryption — a per-record Data Encryption Key (DEK)
encrypts the sensitive field (AES-256-GCM), and the DEK itself is encrypted
("wrapped") by a Key Encryption Key (KEK) held outside the database (env
var / secrets manager in this exercise; a real KMS in production). Rotating
the KEK means re-wrapping DEKs, not re-encrypting every field.

## Payroll Resumability — Checkpoint Pattern

[TODO expand] `payroll_jobs.checkpoint_index` tracks the last successfully
processed line item. On worker restart/retry, processing resumes from
`checkpoint_index` rather than item 0. Each line item additionally carries
its own deterministic idempotency key (`hash(jobId, lineIndex)`), so even if
an already-completed item is re-attempted, the Transaction Service's
idempotency gate (Problem 1) makes it a safe no-op.

## Audit Hash Chain

[TODO expand] Every `ledger_entries` row stores `entry_hash =
sha256(prev_entry_hash + wallet_id + direction + amount + currency)`. Because
each hash depends on the previous one, altering any historical row's amount
or direction changes that row's hash and therefore invalidates every hash
computed after it — a verification pass that recomputes the chain from the
first row will detect exactly where tampering occurred.

## Tradeoffs Made Under Time Pressure

[TODO — fill in as implementation proceeds, e.g.: static FX rate table
instead of a live provider integration; reaper job for Scenario C not yet
scheduled; field-level encryption utility not yet wired into the users
table; OpenTelemetry auto-instrumentation not yet added to each service.]

## What We'd Add Before Production

[TODO — e.g.: real KMS integration, mTLS between services, per-service
independent Postgres instances instead of one shared instance with
per-service databases, dead-letter queue handling for payroll items that
exhaust BullMQ retry attempts, chaos testing for the FX-provider-down and
ledger-service-down scenarios.]
