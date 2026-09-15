# NovaPay — API Reference

> Full interactive schemas live in Swagger UI. This document maps the
> surface and conventions; it never duplicates field-level schemas.

- Swagger UI: [http://localhost:8080/docs](http://localhost:8080/docs)
- OpenAPI JSON: [http://localhost:8080/docs/json](http://localhost:8080/docs/json)
- Gateway base URL: `http://localhost:8080` (dev stack: `:8083`)

All paths below are gateway paths. Internal service ports (3000–3006)
are not exposed to the host.

## Authentication

Public gateway routes require no user credentials in this assessment
stack. Service-to-service calls behind the gateway use per-service
bearer identity (`x-service-id` / `x-service-token`); see
[docs/SERVICE_TO_SERVICE_SECURITY.md](SERVICE_TO_SERVICE_SECURITY.md).

## Endpoints by Service

| Gateway path | Method | Purpose |
|---|---|---|
| `/accounts/users` | POST | Create user (PII encrypted at rest) |
| `/accounts/wallets` | POST | Create wallet |
| `/accounts/wallets/:userId` | GET | List a user's wallets |
| `/accounts/wallets/:walletId/balance` | GET | Wallet balance |
| `/accounts/wallets/:walletId/operations` | POST | Debit/credit (idempotent op key) |
| `/accounts/wallets/:walletId/operations/:operationKey` | GET | Operation lookup |
| `/transactions` | POST | Initiate transfer (`Idempotency-Key` required) |
| `/transactions` | GET | History (`walletId`, `limit` ≤ 100, opaque `cursor`) |
| `/transfers/international` | POST | FX-quoted transfer |
| `/ledger/batches` | POST | Double-entry batch (internal: transaction-service only) |
| `/ledger/batches/:transactionId` | GET | Batch lookup |
| `/ledger/invariant-check` | GET | Live balance invariant |
| `/ledger/audit/verify` | GET | Hash-chain verification |
| `/fx/quote` | POST | Request 60s single-use quote |
| `/fx/quote/:id` | GET | Quote lookup |
| `/fx/quote/:id/consume` | POST | Atomically consume a quote |
| `/payroll/jobs` | POST | Submit batch (≤ 5000 items) |
| `/payroll/jobs/:id` | GET | Job status |
| `/admin/incidents` | POST | Report incident |
| `/admin/ledger-invariant`, `/admin/audit/verify` | GET | Ledger diagnostics |
| `/internal/recover` | POST | Internal only; never routed by the gateway |

## Pagination

`GET /transactions` returns `{ items, nextCursor, hasMore }`.
Keyset cursor (`createdAt` + `id`), default limit 50, max 100.
Details: [docs/TRANSACTION_HISTORY.md](TRANSACTION_HISTORY.md).

## Error Conventions

`{ error: UPPER_SNAKE, message, requestId }` with HTTP status:

| Status | Meaning |
|---|---|
| 400 | `VALIDATION_ERROR`, malformed cursor/UUID/body |
| 401 | Missing/invalid service credentials (internal calls) |
| 403 | Authenticated service not authorized for the endpoint |
| 404 | Unknown route or record |
| 409 | Idempotency conflict (`*_EXPIRED`, `*_PAYLOAD_MISMATCH`, `*_ALREADY_USED`) |
| 422 | Business rule failure (insufficient funds, unbalanced batch, FX mismatch) |
| 503 | Downstream unavailable (`FX_PROVIDER_UNAVAILABLE`, reconciliation errors) |

5xx bodies never contain stacks, paths, SQL, or secrets.
