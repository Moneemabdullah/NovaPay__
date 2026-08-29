# NovaPay — Rebuilt Transaction Backend

Status: **scaffold**. All six services run, connect to their own database,
and expose the endpoints described below. The core safety logic (idempotent
disbursement's crash-recovery path, encryption, and full observability
wiring) is partially stubbed — see inline comments marked `STUB`/`TODO` and
[`decisions.md`](./decisions.md) for exactly what's real vs planned.

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
docker compose up --build
```

This starts Postgres (with 6 per-service databases pre-created + schema
loaded), Redis, all six services, the API gateway on `:8080`, and the
monitoring stack (Prometheus `:9090`, Grafana `:3001`, Jaeger UI `:16686`).

Run a single service's tests locally:
```bash
cd services/transaction-service
npm install
npm test
```

## API Endpoint Summary

| Method | Path | Example Request | Example Response |
|---|---|---|---|
| GET | `/accounts/wallets/:userId` | `GET /accounts/wallets/abc-123` | `{"userId":"abc-123","wallets":[{"id":"...","currency":"USD","balance_cents":10000}]}` |
| POST | `/accounts/wallets` | `{"userId":"abc-123","currency":"USD"}` | `{"id":"...","currency":"USD","balance_cents":0}` |
| POST | `/transactions` (header `Idempotency-Key`) | `{"senderWalletId":"w1","recipientWalletId":"w2","amountCents":10000,"currency":"USD"}` | `{"transactionId":"...","status":"completed"}` |
| POST | `/ledger/batches` | `{"transactionId":"t1","entries":[{"wallet_id":"w1","direction":"debit","amount_cents":10000,"currency":"USD"},{"wallet_id":"w2","direction":"credit","amount_cents":10000,"currency":"USD"}]}` | `{"batchId":"..."}` |
| GET | `/ledger/invariant-check` | `GET /ledger/invariant-check` | `{"delta":0,"ok":true}` |
| POST | `/fx/quote` | `{"baseCurrency":"USD","quoteCurrency":"BDT"}` | `{"id":"...","rate":118.5,"expires_at":"..."}` |
| GET | `/fx/quote/:id` | `GET /fx/quote/abc` | `{"valid":true,"msRemaining":42000,...}` |
| POST | `/transfers/international` | *(planned — not yet implemented)* | — |
| POST | `/payroll/jobs` | `{"employerAccountId":"e1","items":[{"recipientWalletId":"w2","amountCents":50000}]}` | `{"jobId":"...","totalItems":1,"status":"queued"}` |
| GET | `/payroll/jobs/:id` | `GET /payroll/jobs/j1` | `{"status":"running","checkpoint_index":4200,...}` |
| POST | `/admin/incidents` | `{"adminUser":"karim","note":"..."}` | `{"id":"...","note":"..."}` |

## Idempotency Scenarios (A–E)

See [`decisions.md`](./decisions.md#problem-1--idempotent-disbursement) for
the full explanation of each scenario and exactly where it's enforced in
code.

## Double-Entry Invariant

Every money movement writes exactly two `ledger_entries` rows (one debit,
one credit) inside a single DB transaction (`ledger-service`). The
invariant `SUM(debit) == SUM(credit)` is checked live via
`GET /ledger/invariant-check` and is intended to back a Prometheus alert
that fires the instant the delta is nonzero (see `decisions.md`).

## FX Quote Strategy

60-second TTL, single-use, atomic consume-on-use, no fallback to cached
rates on provider failure. Full explanation in
[`decisions.md`](./decisions.md#problem-3--fx-rate-locking).

## Payroll Resumability

Checkpoint-index pattern + deterministic per-item idempotency keys. Full
explanation in [`decisions.md`](./decisions.md#payroll-resumability--checkpoint-pattern).

## Audit Hash Chain

Explained in [`decisions.md`](./decisions.md#audit-hash-chain).

## Tradeoffs Made Under Time Pressure / What's Next

See the bottom two sections of [`decisions.md`](./decisions.md).
