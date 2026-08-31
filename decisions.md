# Design Decisions

This file documents the reasoning behind the harder design calls in this
system, per the assessment's requirements.

## Problem 1 — Idempotent Disbursement

### Scenario A: Same key arrives twice

**Mechanism:** The idempotency key is the primary key of `idempotency_keys`.
A duplicate request with a `status = 'completed'` row replays the cached
`response_body` and never re-enters the debit/credit path.

**Code path:** `transaction-service/src/services/transaction.service.ts:17-26`
— `execute()` checks the current status; if `COMPLETED`, it reads the cached
response from `idempotency_keys` and returns immediately.

### Scenario B: Three identical requests within 100ms

**Mechanism:** All three attempt `INSERT INTO idempotency_keys (key, ...)`.
Postgres's UNIQUE constraint on `key` allows exactly one INSERT to succeed;
the other two get a `23505 unique_violation` at the database level and are
routed to `handleExistingKey`, which either replays the winner's response or
returns `202 processing` if the winner hasn't finished yet. The two losing
requests never write a transaction or ledger row — the race is resolved by
Postgres's own uniqueness enforcement, not application-level locking.

**Code path:** `transaction-service/src/services/transaction.service.ts:216-261`
— `initiate()` wraps the idempotency key create + transaction create in
`prisma.$transaction`. The `P2002` error (unique violation) is caught at
line 239 and routed to the duplicate handling path at lines 240-260.

### Scenario C: Crash between debit and credit (atomicity)

**Mechanism:** The transaction row moves `PROCESSING → COMPLETED` or
`PROCESSING → REVERSED` as explicit states. A recovery endpoint
(`POST /internal/recover`) periodically scans for transactions stuck in
`PROCESSING` older than 60 seconds and reconciles against the account
service:

1. If the sender's debit was reversed (detected via operation lookup on the
   account service), the transaction is marked `REVERSED` — no ledger batch,
   no recipient credit.
2. If a ledger batch exists, the debit and ledger are committed; the
   recipient is credited and the transaction is marked `COMPLETED`.
3. If neither applies, the process crashed before the debit was applied;
   no action needed.

**Code paths:**
- Execute: `transaction-service/src/services/transaction.service.ts:7-182`
- Recovery: `transaction-service/src/routes/transaction.routes.ts:19-28`

The two-phase status update, plus the ledger's own all-or-nothing batch
INSERT (single DB transaction wrapping both entries in `ledger-service`),
together prevent a permanently unbalanced ledger.

### Scenario D: Key expires after 24h, retried at 30h

**Mechanism:** `handleExistingKey` checks `expires_at`. An expired key returns
`410 Gone` (or `409 IDEMPOTENCY_KEY_EXPIRED`) with an explicit message that
the request will be treated as new on resubmission — it is never silently
replayed and never silently reprocessed as a duplicate.

**Code path:** `transaction-service/src/services/transaction.service.ts:242-248`

### Scenario E: Same key, different payload

**Mechanism:** The request body is SHA-256 hashed and stored alongside the
key. A second request with the same key but a different hash returns
`409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` — it is rejected outright, not merged
or overwritten.

**Code path:** `transaction-service/src/services/transaction.service.ts:249-255`

## Problem 2 — Bulk Payroll Queue Design

**Summary:** One BullMQ queue per employer account, one Worker per queue at
`concurrency: 1`. This serializes writes against a single employer's funding
account without a global lock (which would serialize unrelated employers) or
a long-held DB row lock (which would create severe contention across
sequential debits).

**Code paths:**
- Queue creation: `payroll-service/src/services/payroll.service.ts:29-31`
- Worker: `payroll-service/src/worker.ts:5-8`

**Checkpoint pattern:** `payroll_jobs.checkpoint_index` tracks the last
successfully processed line item. On worker restart/retry, processing resumes
from `checkpoint_index` rather than item 0. Each line item additionally
carries its own deterministic idempotency key (`sha256(jobId:lineIndex)`),
so even if an already-completed item is re-attempted, the Transaction
Service's idempotency gate makes it a safe no-op.

**Code path:** `payroll-service/src/services/payroll.service.ts:68-80`

## Problem 3 — FX Rate Locking

**Mechanism:** `fx-service` issues quotes with a 60-second TTL
(`fx_quotes.expires_at`). Consumption is atomic:
`UPDATE fx_quotes SET used=true WHERE id=$1 AND used=false AND expires_at>now()`
in a single statement, so a quote cannot be used twice even under concurrent
attempts — whichever request's UPDATE matches zero rows gets
`409 FX_QUOTE_ALREADY_USED` or `409 FX_QUOTE_EXPIRED`.

Provider outage returns `503 FX_PROVIDER_UNAVAILABLE` and never falls back
to a cached rate.

**Code paths:**
- Quote creation: `fx-service/src/services/fx.service.ts:11-24`
- Atomic consume: `fx-service/src/services/fx.service.ts:30-53`
- Provider down: `fx-service/src/routes/fx.routes.ts:28-36`

## Problem 4 — Field-Level Encryption

**Mechanism:** Envelope encryption:
1. A per-record Data Encryption Key (DEK) — random 32-byte key — encrypts
   the sensitive field (AES-256-GCM), producing ciphertext + IV + auth tag.
2. The DEK itself is encrypted ("wrapped") by a Key Encryption Key (KEK)
   derived from the `FIELD_ENCRYPTION_KEK` environment variable via SHA-256.
3. The wrapped DEK and encrypted fields are stored in the `users` table.

Rotating the KEK means re-wrapping DEKs, not re-encrypting every field.

**Code path:** `account-service/src/services/crypto.service.ts:7-31`

**Note:** The encryption utility is implemented and used on write. A
decryption utility for reading PII back has not yet been implemented.

## Audit Hash Chain

Every `ledger_entries` row stores `entry_hash = sha256(prev_entry_hash + wallet_id + direction + amount + currency)`. Because each hash depends on the previous one, altering any historical row's amount or direction changes that row's hash and therefore invalidates every hash computed after it — a verification pass that recomputes the chain from the first row will detect exactly where tampering occurred.

**Code path:** `ledger-service/src/services/ledger.service.ts:21-32, 133-144`

## Tradeoffs Made Under Time Pressure

- Static FX rate table instead of a live provider integration
- Single shared Postgres instance with per-service databases (production would use independent instances)
- No mTLS between services
- No dead-letter queue for payroll items that exhaust BullMQ retries
- Field-level encryption encrypts on write but decryption utility not yet wired into read paths
- OpenTelemetry infrastructure (Jaeger) deployed but application-level instrumentation not yet added

## What We'd Add Before Production

- Real KMS integration for KEK management
- mTLS between services
- Per-service independent Postgres instances instead of one shared instance with per-service databases
- Dead-letter queue handling for payroll items that exhaust BullMQ retry attempts
- Chaos testing for the FX-provider-down and ledger-service-down scenarios
- OpenTelemetry auto-instrumentation for distributed tracing
- Decryption utility for PII read paths
