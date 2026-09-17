# NovaPay — Load Testing

## Purpose

Repeatable, dependency-free load measurement for the live stack:
throughput, latency distribution, and error rate — plus proof that
business-path load conserves money exactly.

## Architecture / Environment

`scripts/load/load-test.mjs` (plain Node 20+, no packages) drives HTTP
against the running Docker stack (production compose, 16 containers).
Results below were measured against that configuration.

## How to Run

```bash
# Safe read-only baseline (default: GET /docs/json, 20 rps, 30 s)
make load-test
# Heavier read load
make load-test URL=http://localhost:8080/docs/json RATE=100 DURATION=30
```

## Safe Defaults

The default target is read-only. Anything non-GET requires `WRITE=1`.

## Write-Test Requirements

Business-path runs require `WRITE=1`, synthetic wallets created for the
run only, and per-request keys via `IDEMPOTENCY_PREFIX=loadtest-...`,
so measurements can never be mistaken for real activity:

```bash
WRITE=1 make load-test METHOD=POST URL=http://localhost:8080/transactions \
  BODY='{"senderWalletId":"...","recipientWalletId":"...","amountCents":100,"currency":"USD"}' \
  IDEMPOTENCY_PREFIX=loadtest- RATE=5 DURATION=60
```

## Configuration / Options

| Option | Default | Meaning |
|---|---|---|
| `URL` | `http://localhost:8080/docs/json` | Target |
| `METHOD` | `GET` | `GET` always allowed; others need `WRITE=1` |
| `BODY` | `{}` | JSON body; `{i}` expands to the request index |
| `HEADERS` | `{}` | Extra JSON headers |
| `IDEMPOTENCY_PREFIX` | unset | Adds `Idempotency-Key: <prefix><i>` per request |
| `RATE` | `20` | Target req/s (`0` = as fast as possible) |
| `DURATION` | `30` | Seconds to run |
| `CONCURRENCY` | `10` | Max in-flight requests |

## Metrics Collected

Total / successful / failed requests, error rate, sustained req/s,
average / p50 / p95 / p99 latency, and per-status error breakdown —
printed as JSON.

## Baseline Results

600 requests at 20 rps, 0% errors: p50 5 ms, p95 8.3 ms, p99 15.1 ms.

## 100 rps Results

3,000 requests at 100 rps, 0% errors: p50 4.7 ms, p95 33.7 ms,
p99 123.8 ms.

## Business Transfer Results

300 real `POST /transactions` at 5 rps, **300/300 successful, 0%
errors**: p50 267 ms, p95 721 ms, p99 1,471 ms. Sender balance
reconciled exactly to 970,000 cents; Prometheus stayed 8/8 throughout.

## Interpretation / Limitations

These measurements represent the tested live-stack configuration and
are **not a formal maximum-capacity claim** — no 1000 rps test was run
and none is claimed. Latency on the transfer path reflects full
debit → ledger → credit orchestration per request. Results are
environment-specific (single host, shared Postgres/Redis) and will
shift with hardware, data volume, and concurrency settings.

## How to Reproduce

1. `make build-up` (or `make up`), wait for healthy services.
2. Run the baseline, then the desired scenario from this document.
3. Compare the printed JSON summary; re-check balances via
   `GET /accounts/wallets/:id/balance` for business runs.
