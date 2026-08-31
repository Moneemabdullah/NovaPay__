# NovaPay — Transaction Backend

Status: **implemented**. All six services run, connect to their own database, and expose the endpoints described below.

## Architecture

```
                         ┌──────────────────────┐
                         │        CLIENT        │
                         └──────────┬───────────┘
                                    │
                                    │ :8080
                                    ▼
                         ┌──────────────────────┐
                         │     API GATEWAY      │
                         │       :3000          │
                         └──────────┬───────────┘
                                    │
          ┌─────────────┬───────────┼───────────┬─────────────┬─────────────┐
          │             │           │           │             │             │
          ▼             ▼           ▼           ▼             ▼             ▼
   ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌───────────┐
   │  ACCOUNT   │ │ TRANSACTION│ │  LEDGER  │ │    FX    │ │  PAYROLL   │ │   ADMIN   │
   │   :3001    │ │   :3002    │ │  :3003   │ │  :3004   │ │   :3005    │ │  :3006    │
   └─────┬──────┘ └─────┬──────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘ └─────┬─────┘
         │              │             │            │             │              │
         ▼              ▼             ▼            ▼             ▼              ▼
   ┌───────────┐  ┌───────────┐ ┌──────────┐  ┌──────────┐ ┌───────────┐ ┌──────────┐
   │ Account DB│  │Transaction│ │ Ledger DB│  │   FX DB  │ │ Payroll DB│ │ Admin DB │
   │ PostgreSQL│  │    DB     │ │PostgreSQL│  │PostgreSQL│ │ PostgreSQL│ │PostgreSQL│
   └───────────┘  │ PostgreSQL│ └──────────┘  └──────────┘ └───────────┘ └──────────┘
                  └───────────┘


                  ───────── TRANSACTION ORCHESTRATION ─────────

                     ┌─────────────────────┐
                     │  Transaction :3002  │
                     └──────────┬──────────┘
                                │
                ┌───────────────┼────────────────┐
                │               │                │
                ▼               ▼                ▼
          Account :3001     FX :3004        Ledger :3003
          Wallet ops        Locked quote    Double-entry
                                             batch


                  ───────── ASYNCHRONOUS PAYROLL ─────────

┌───────────────┐    ┌───────────────┐    ┌─────────────────┐    ┌────────────────┐
│ Payroll :3005 │───▶│ Redis :6379   │───▶│ Workers         │───▶│ Transaction    │
│               │    │ BullMQ        │    │ per-employer    │    │ :3002          │
└───────────────┘    └───────────────┘    │ concurrency: 1  │    └────────────────┘
                                          └─────────────────┘

                  ───────── OBSERVABILITY ─────────

          ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
          │ Prometheus   │────▶│   Grafana    │     │    Jaeger    │
          │    :9090     │     │    :3000     │     │    :16686    │
          └──────────────┘     └──────────────┘     └──────────────┘
```

No service reads or writes another service's database directly — all cross-service communication is over HTTP, enforced at the infra level by giving each service its own Postgres database (see `scripts/init-multi-db.sh`).

## Setup

```bash
docker compose -f infra/docker-compose.yml up --build -d
```

This starts Postgres (with 6 per-service databases pre-created + schema loaded), Redis, all six services, the API gateway on `:8080` via nginx, and the monitoring stack (Prometheus `:9090`, Grafana `:3007`, Jaeger UI `:16686`).

No `.env` files are required — all configuration is self-contained in `infra/docker-compose.yml`.

Run a single service's tests locally:

```bash
cd services/transaction-service
npm install
npm test
```

Run integration tests (requires the Docker Postgres):

```bash
cd services/transaction-service
npm run test:integration
```

## API Endpoint Summary

All endpoints are accessed through the API gateway at `http://localhost:8080`.

### Account Service

#### POST /accounts/users

Create a user (PII encrypted at rest).

```bash
curl -s -X POST http://localhost:8080/accounts/users \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","fullName":"Alice Smith","phone":"+1234567890"}'
```

Response `201`:
```json
{
  "id": "a1b2c3d4-...",
  "email": "alice@example.com",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

> **Note:** PII fields (`fullName`, `phone`) are encrypted at rest and not returned in API responses. Only `id`, `email`, and `createdAt` are exposed.

#### POST /accounts/wallets

Create a wallet for a user.

```bash
curl -s -X POST http://localhost:8080/accounts/wallets \
  -H "Content-Type: application/json" \
  -d '{"userId":"a1b2c3d4-...","currency":"USD"}'
```

Response `201`:
```json
{
  "id": "w1x2y3z4-...",
  "userId": "a1b2c3d4-...",
  "currency": "USD",
  "balanceCents": 0,
  "version": 1,
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

#### GET /accounts/wallets/:userId

List wallets for a user.

```bash
curl -s http://localhost:8080/accounts/wallets/a1b2c3d4-...
```

Response `200`:
```json
{
  "userId": "a1b2c3d4-...",
  "wallets": [
    {
      "id": "w1x2y3z4-...",
      "currency": "USD",
      "balanceCents": "100000",
      "version": 1,
      "status": "active"
    }
  ]
}
```

#### GET /accounts/wallets/:walletId/balance

Get wallet balance.

```bash
curl -s http://localhost:8080/accounts/wallets/w1x2y3z4-.../balance
```

Response `200`:
```json
{
  "id": "w1x2y3z4-...",
  "userId": "a1b2c3d4-...",
  "currency": "USD",
  "balanceCents": "100000",
  "version": 1,
  "status": "active"
}
```

#### POST /accounts/wallets/:walletId/operations

Apply a wallet operation (debit/credit).

```bash
curl -s -X POST http://localhost:8080/accounts/wallets/w1x2y3z4-.../operations \
  -H "Content-Type: application/json" \
  -d '{"operationKey":"deposit-001","deltaCents":50000}'
```

Response `200`:
```json
{
  "id": "op1a2b3c-...",
  "walletId": "w1x2y3z4-...",
  "operationKey": "deposit-001",
  "deltaCents": 50000,
  "balanceAfterCents": 150000,
  "version": 2
}
```

### Transaction Service

#### POST /transactions

Initiate a domestic transfer (requires `Idempotency-Key` header).

```bash
curl -s -X POST http://localhost:8080/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: txn-001" \
  -d '{
    "senderWalletId": "w1x2y3z4-...",
    "recipientWalletId": "w5a6b7c8-...",
    "amountCents": 10000,
    "currency": "USD"
  }'
```

Response `201`:
```json
{
  "transactionId": "t9r8s7t6-...",
  "status": "COMPLETED",
  "senderWalletId": "w1x2y3z4-...",
  "recipientWalletId": "w5a6b7c8-...",
  "amountCents": 10000,
  "currency": "USD"
}
```

#### POST /transfers/international

Initiate an international transfer (requires FX quote).

```bash
curl -s -X POST http://localhost:8080/transfers/international \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: intl-001" \
  -d '{
    "senderWalletId": "w1x2y3z4-...",
    "recipientWalletId": "w5a6b7c8-...",
    "amountCents": 10000,
    "currency": "USD",
    "quoteId": "q1u2o3t4-..."
  }'
```

Response `201`:
```json
{
  "transactionId": "t4e5f6g7-...",
  "status": "COMPLETED"
}
```

### Ledger Service

#### POST /ledger/batches

Write a double-entry ledger batch.

```bash
curl -s -X POST http://localhost:8080/ledger/batches \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "t9r8s7t6-...",
    "entries": [
      {"walletId":"w1x2y3z4-...","direction":"DEBIT","amountCents":10000,"currency":"USD"},
      {"walletId":"w5a6b7c8-...","direction":"CREDIT","amountCents":10000,"currency":"USD"}
    ]
  }'
```

Response `201`:
```json
{
  "transactionId": "t9r8s7t6-...",
  "batchId": "b1a2t3c4-...",
  "entries": [
    {"id":"1","walletId":"w1x2y3z4-...","direction":"DEBIT","amountCents":"10000","currency":"USD"},
    {"id":"2","walletId":"w5a6b7c8-...","direction":"CREDIT","amountCents":"10000","currency":"USD"}
  ]
}
```

#### GET /ledger/batches/:transactionId

Retrieve a ledger batch.

```bash
curl -s http://localhost:8080/ledger/batches/t9r8s7t6-...
```

Response `200`:
```json
{
  "transactionId": "t9r8s7t6-...",
  "entries": [
    {"id":"1","walletId":"w1x2y3z4-...","direction":"DEBIT","amountCents":"10000","currency":"USD"},
    {"id":"2","walletId":"w5a6b7c8-...","direction":"CREDIT","amountCents":"10000","currency":"USD"}
  ]
}
```

#### GET /ledger/invariant-check

Check ledger double-entry invariant.

```bash
curl -s http://localhost:8080/ledger/invariant-check
```

Response `200`:
```json
{
  "invariantHolds": true,
  "totalDebitCents": 150000,
  "totalCreditCents": 150000,
  "delta": 0
}
```

#### GET /ledger/audit/verify

Verify audit hash chain.

```bash
curl -s http://localhost:8080/ledger/audit/verify
```

Response `200`:
```json
{
  "valid": true,
  "entriesChecked": 12,
  "firstEntryHash": "a1b2c3...",
  "lastEntryHash": "x9y8z7..."
}
```

### FX Service

#### POST /fx/quote

Create an FX quote (60s TTL).

```bash
curl -s -X POST http://localhost:8080/fx/quote \
  -H "Content-Type: application/json" \
  -d '{"baseCurrency":"USD","quoteCurrency":"BDT"}'
```

Response `201`:
```json
{
  "id": "q1u2o3t4-...",
  "baseCurrency": "USD",
  "quoteCurrency": "BDT",
  "rate": "110.50",
  "expiresAt": "2025-01-15T10:31:00.000Z",
  "used": false
}
```

#### GET /fx/quote/:id

Check FX quote validity.

```bash
curl -s http://localhost:8080/fx/quote/q1u2o3t4-...
```

Response `200`:
```json
{
  "id": "q1u2o3t4-...",
  "baseCurrency": "USD",
  "quoteCurrency": "BDT",
  "rate": "110.50",
  "expiresAt": "2025-01-15T10:31:00.000Z",
  "used": false
}
```

#### POST /fx/quote/:id/consume

Atomically consume an FX quote.

```bash
curl -s -X POST http://localhost:8080/fx/quote/q1u2o3t4-.../consume \
  -H "Content-Type: application/json" \
  -d '{"transactionId":"t4e5f6g7-..."}'
```

Response `200`:
```json
{
  "id": "q1u2o3t4-...",
  "baseCurrency": "USD",
  "quoteCurrency": "BDT",
  "rate": "110.50",
  "used": true,
  "usedByTransactionId": "t4e5f6g7-..."
}
```

### Payroll Service

#### POST /payroll/jobs

Create a payroll batch job.

```bash
curl -s -X POST http://localhost:8080/payroll/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "employerAccountId": "acc-employer-001",
    "items": [
      {"recipientWalletId":"w5a6b7c8-...","amountCents":50000},
      {"recipientWalletId":"w9i0j1k2-...","amountCents":75000}
    ]
  }'
```

Response `202`:
```json
{
  "jobId": "pj1a2b3c-...",
  "totalItems": 2,
  "status": "queued"
}
```

#### GET /payroll/jobs/:id

Get payroll job status.

```bash
curl -s http://localhost:8080/payroll/jobs/pj1a2b3c-...
```

Response `200`:
```json
{
  "id": "pj1a2b3c-...",
  "employerAccountId": "acc-employer-001",
  "status": "completed",
  "totalItems": 2,
  "processedItems": 2,
  "checkpointIndex": 2
}
```

### Admin Service

#### POST /admin/incidents

Record an incident note.

```bash
curl -s -X POST http://localhost:8080/admin/incidents \
  -H "Content-Type: application/json" \
  -d '{"adminUser":"ops@novapay.com","transactionId":"t9r8s7t6-...","note":"Manual review required"}'
```

Response `201`:
```json
{
  "id": "inc1a2b3c-...",
  "adminUser": "ops@novapay.com",
  "transactionId": "t9r8s7t6-...",
  "note": "Manual review required",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

## Idempotency Scenarios (A–E)

All five scenarios are implemented in the transaction service:

**Scenario A — Same key arrives twice:**
The idempotency key is the primary key of `idempotency_keys`. A duplicate request with a `completed` row replays the cached `response_body` and never re-enters the debit/credit path.

**Scenario B — Three identical requests within 100ms:**
All three attempt `INSERT INTO idempotency_keys (key, ...)`. Postgres's UNIQUE constraint on `key` allows exactly one INSERT to succeed; the other two get a `23505 unique_violation` and are routed to `handleExistingKey`, which either replays the winner's response or returns `202 processing` if the winner hasn't finished yet.

**Scenario C — Crash between debit and credit:**
The transaction row moves `PROCESSING → COMPLETED` or `PROCESSING → REVERSED`. A recovery endpoint (`POST /internal/recover`) scans for transactions stuck in `PROCESSING` older than 60 seconds and reconciles against the account service: if the debit was reversed, the transaction is marked `REVERSED`; if a ledger batch exists, the credit is completed.

**Scenario D — Key expires after 24h, retried at 30h:**
`handleExistingKey` checks `expires_at`. An expired key returns `409 IDEMPOTENCY_KEY_EXPIRED`.

**Scenario E — Same key, different payload:**
The request body is SHA-256 hashed. A second request with the same key but a different hash returns `409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`.

## Double-Entry Invariant

Every money movement writes exactly two `ledger_entries` rows (one debit, one credit) inside a single DB transaction (`ledger-service`). The invariant `SUM(debit) == SUM(credit)` is checked live via `GET /ledger/invariant-check` and exposes a Prometheus gauge for alerting.

An audit hash chain (`entry_hash = sha256(prev_hash + wallet_id + direction + amount + currency)`) is maintained across all entries. Verification is available at `GET /ledger/audit/verify`.

## Crash Recovery

The `POST /internal/recover` endpoint finds transactions stuck in `PROCESSING` for over 60 seconds and reconciles:

1. **Check if the sender debit was reversed** — queries the account service for the reversal operation. If found, marks the transaction `REVERSED`.
2. **Check if a ledger batch exists** — if yes, the debit and ledger are committed; completes the credit and marks `COMPLETED`.
3. **Otherwise** — the debit was never applied or the process crashed before it; no action needed.

The recovery is idempotent and never creates money.

## FX Quote Strategy

- 60-second TTL per quote
- Single-use: atomic `UPDATE ... WHERE used=false AND expires_at>now()`
- Provider outage returns `503 FX_PROVIDER_UNAVAILABLE` — never falls back to cached rates
- Concurrent consumption attempts get `409 FX_QUOTE_ALREADY_USED` or `409 FX_QUOTE_EXPIRED`

## Payroll Queue Design

- One BullMQ queue per employer account (`payroll:{employerAccountId}`)
- `concurrency: 1` per Worker — serializes writes per employer without global locks
- Checkpoint-index pattern: `checkpoint_index` tracks the last successfully processed line item
- On worker restart, processing resumes from `checkpoint_index`
- Each line item has a deterministic idempotency key (`sha256(jobId:lineIndex)`)

## Field-Level Encryption

Envelope encryption for PII (fullName, phone):

- Per-record Data Encryption Key (DEK) — random 32-byte key
- DEK encrypts fields using AES-256-GCM (ciphertext + IV + auth tag)
- DEK itself is encrypted ("wrapped") by a Key Encryption Key (KEK) from `FIELD_ENCRYPTION_KEK` env var
- Stored in `users` table: `full_name_enc`, `full_name_iv`, `full_name_tag`, `dek_wrapped`

## Observability

- **Prometheus metrics**: HTTP request duration histograms, transaction counters, ledger invariant violations, FX provider failures
- **Grafana dashboards**: provisioned with alerting rules
- **Jaeger**: OTLP collectors configured at ports 4317/4318

## CI/CD

GitHub Actions pipeline (`.github/workflows/ci.yml`):

1. `dorny/paths-filter@v4` detects which services changed
2. Per-service matrix: `npm ci` → unit tests → integration tests → TypeScript typecheck → version bump validation → Docker build
3. `ci-status` gate job (required check) fails if any step fails
4. Integration tests run against GitHub Actions Postgres/Redis service containers

## Tradeoffs Made Under Time Pressure

- Static FX rate table instead of a live provider integration
- Single shared Postgres instance with per-service databases (production would use independent instances)
- No mTLS between services
- No dead-letter queue for payroll items that exhaust BullMQ retries
- Field-level encryption encrypts on write but decryption utility not yet wired into read paths

## Production Improvements

- Real KMS integration for KEK management
- mTLS between services
- Independent Postgres instances per service
- Dead-letter queue handling for failed payroll items
- Decryption utility for PII read paths
- Chaos testing for FX-provider-down and ledger-service-down scenarios
- Live FX provider integration with circuit breaker
