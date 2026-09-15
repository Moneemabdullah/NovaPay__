# NovaPay — Database Integrity & Performance

## Problem

Six logical databases (one Postgres role) carry money. This audit
verified constraints, bounded every query pattern, and measured the
queries that matter instead of assuming.

## Why It Matters

Financial correctness must not rest on application code alone:
uniqueness, foreign keys, precision, and bounded reads are the last
line of defense when services crash mid-flow.

## Architecture

One Postgres 16 instance, six databases (`account_db`,
`transaction_db`, `ledger_db`, `fx_db`, `payroll_db`, `admin_db`),
created by `scripts/init-multi-db.sh`. Each service connects only to
its own database — verified by `DATABASE_URL` in both compose files.

## Definitions

- **Bounded read**: every `findMany` has `take` and deterministic order,
  or a naturally tiny domain (wallets per user, unique by currency).
- **Keyset scan**: cursor pagination on `(createdAt, id)` / monotonic
  `id`, never OFFSET over money tables.
- **Composite leftmost rule**: an index on `(a, b, c)` serves equality
  on `a` plus ordering/range on `b, c`.

## Current Implementation

**Constraints (all verified present, no changes needed):**
idempotency-key PK + request-hash + 24h expiry; wallet
`@@unique([userId, currency])` + FK to users; wallet-op
`@@unique([walletId, operationKey])` (replay safety); payroll
`@@unique([jobId, lineIndex])`; ledger `transactionId @@unique`;
`Decimal(18,8)` FX rates; `amount_cents BIGINT CHECK > 0`.

**Bounded reads (all verified):** history `take: limit+1`; ledger
audit keyset-batched (1000); payroll items capped by the 5000-item
batch bound; recovery scan now `take: 100` oldest-first (was
unbounded); wallet lists bounded by the per-currency unique.

**Indexes:** migration `0002_history_indexes` added the two wallet-side
history composites. Stale-recovery scan measured at 3 ms via the
existing status index — no new index (evidence over assumption).

## Failure Behavior

- Duplicate key/operation/quote inserts fail at the DB layer even if
  application guards race.
- A tick that finds >100 stale rows processes the oldest 100; the rest
  wait ≤60s for the next tick — deterministic progress, bounded memory.

## Security Considerations

- Single shared `novapay` role across all six databases with broad
  grants: convenient for local assessment, must become per-service
  least-privilege roles with rotated secrets in any real deployment
  (deliberately not rotated here — no secret automation exists).
- Credentials live in compose env (dev defaults) and local `.env`
  (gitignored); never in responses or logs.

## Testing

- `recovery.test.ts` asserts the scan bound (`take ≤ 100`) and
  oldest-first order alongside the cutoff shape.
- Existing suites cover uniqueness (P2002 replay paths), FK behavior,
  rollback (atomic `$transaction` blocks), and ledger balance.
- Migration `0002` applied cleanly to a scratch database; index list
  verified.

## Tradeoffs

- Kept the pre-existing single-column wallet indexes: dropping them
  showed no measured benefit and the planner demonstrably mixes them
  into BitmapOr plans — removal risk without payoff.
- No read replicas/partitioning: measured hot paths are single-digit
  milliseconds; scaling levers documented in
  `docs/TRANSACTION_HISTORY.md` for when they are actually needed.

## Limitations

- No per-service DB roles; no connection-pool tuning (Prisma defaults).
- EXPLAIN evidence was gathered at 20–30k rows — planner choices
  should be re-verified if tables grow 100×.
