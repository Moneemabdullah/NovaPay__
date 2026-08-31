# NovaPay — Transaction Backend

Status: **implemented**. All six services run, connect to their own database,
and expose the endpoints described below.

## Architecture

```
                        ┌────────────────┐
 client ───────────────▶│  API Gateway   │
                        └───────┬────────┘
        ┌───────────┬───────────┼───────────┬────────────┬───────────┐
        ▼           ▼           ▼            ▼            ▼           ▼
   Account     Transaction   Ledger        FX         Payroll      Admin
   Service      Service     Service      Service      Service     Service
        │           │           │            │            │           │
        ▼           ▼           ▼            ▼            ▼           ▼
   [accounts]  [transactions] [ledger]     [fx]       [payroll]   [admin]
                                                (each its own Postgres DB)

  transaction-service ──▶ ledger-service   (writes double-entry batches)
  transaction-service ──▶ fx-service       (consumes locked quotes)
  payroll-service ──▶ BullMQ (Redis) ──▶ per-employer queues ──▶ transaction-service
```

No service reads or writes another service's database directly — all
cross-service communication is over HTTP, enforced at the infra level by
giving each service its own Postgres database (see
`scripts/init-multi-db.sh`).

## Setup

```bash
docker compose up --build -d
```

This starts Postgres (with 6 per-service databases pre-created + schema
loaded), Redis, all six services, the API gateway on `:8080` via nginx,
and the monitoring stack (Prometheus `:9090`, Grafana `:3007`, Jaeger UI `:16686`).

No `.env` files are required — all configuration is self-contained in
`docker-compose.yml`.

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

| Method | Path | Description |
|---|---|---|
| POST | `/accounts/users` | Create a user (PII encrypted at rest) |
| POST | `/accounts/wallets` | Create a wallet for a user |
| GET | `/accounts/wallets/:userId` | List wallets for a user |
| GET | `/accounts/wallets/:walletId/balance` | Get wallet balance |
| POST | `/accounts/wallets/:walletId/operations` | Apply a wallet operation (debit/credit) |
| POST | `/transactions` | Initiate a domestic transfer (requires `Idempotency-Key` header) |
| POST | `/transfers/international` | Initiate an international transfer (requires FX quote) |
| POST | `/ledger/batches` | Write a double-entry ledger batch |
| GET | `/ledger/batches/:transactionId` | Retrieve a ledger batch |
| GET | `/ledger/invariant-check` | Check ledger double-entry invariant |
| GET | `/ledger/audit/verify` | Verify audit hash chain |
| POST | `/fx/quote` | Create an FX quote (60s TTL) |
| GET | `/fx/quote/:id` | Check FX quote validity |
| POST | `/fx/quote/:id/consume` | Atomically consume an FX quote |
| POST | `/payroll/jobs` | Create a payroll batch job |
| GET | `/payroll/jobs/:id` | Get payroll job status |
| POST | `/admin/incidents` | Record an incident note |

## Idempotency Scenarios (A–E)

All five scenarios are implemented in the transaction service:

**Scenario A — Same key arrives twice:**
The idempotency key is the primary key of `idempotency_keys`. A duplicate
request with a `completed` row replays the cached `response_body` and never
re-enters the debit/credit path.

**Scenario B — Three identical requests within 100ms:**
All three attempt `INSERT INTO idempotency_keys (key, ...)`.
Postgres's UNIQUE constraint on `key` allows exactly one INSERT to succeed;
the other two get a `23505 unique_violation` and are routed to
`handleExistingKey`, which either replays the winner's response or returns
`202 processing` if the winner hasn't finished yet.

**Scenario C — Crash between debit and credit:**
The transaction row moves `PROCESSING → COMPLETED` or `PROCESSING → REVERSED`.
A recovery endpoint (`POST /internal/recover`) scans for transactions stuck
in `PROCESSING` older than 60 seconds and reconciles against the account
service: if the debit was reversed, the transaction is marked `REVERSED`;
if a ledger batch exists, the credit is completed.

**Scenario D — Key expires after 24h, retried at 30h:**
`handleExistingKey` checks `expires_at`. An expired key returns
`409 IDEMPOTENCY_KEY_EXPIRED`.

**Scenario E — Same key, different payload:**
The request body is SHA-256 hashed. A second request with the same key but
a different hash returns `409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`.

## Double-Entry Invariant

Every money movement writes exactly two `ledger_entries` rows (one debit,
one credit) inside a single DB transaction (`ledger-service`). The
invariant `SUM(debit) == SUM(credit)` is checked live via
`GET /ledger/invariant-check` and exposes a Prometheus gauge for alerting.

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
- OpenTelemetry auto-instrumentation for distributed tracing
- Chaos testing for FX-provider-down and ledger-service-down scenarios
