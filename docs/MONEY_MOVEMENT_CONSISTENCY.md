# NovaPay — Money-Movement Consistency Audit

## Problem

`execute()` — the transfer orchestrator (debit → ledger batch → credit)
— could run twice concurrently for one transaction (slow live request
past the 60s staleness bound + scheduler tick, or manual
`/internal/recover` during a live transfer). The scheduler lease covered
recovery-vs-recovery only. Interleaving **reversal (compensation)** with
**forward progress (ledger batch + credit)** creates money: sender
debited then reversed (net zero) while the recipient keeps a credit from
a balanced-but-aborted ledger batch.

## Why It Matters

Every other failure boundary is absorbed by idempotency keys and
conditional writes — except this one, where two executors each act
correctly on stale reads and the combination invents funds.

## Current Architecture

```
Client → Gateway → Transaction Service (initiate → execute)
                                          ├─▶ Account Service (debit/credit/reversal, op-key idempotent)
                                          └─▶ Ledger Service (batches, tx-keyed replay)
Recovery scheduler (60s tick) ──▶ same execute()
```

## Transaction State Machine

| State | Writer | Side effects so far | Retry-safe |
|---|---|---|---|
| PENDING | initiate (row create) | none | yes (key replay → 202) |
| PROCESSING | initiate | possibly partial | yes (execute re-checks) |
| COMPLETED | execute, conditional on PROCESSING | full movement durable | yes (replay stored body) |
| REVERSED | execute, conditional on PROCESSING | debit compensated | yes (terminal no-op) |
| FAILED | initiate (FX path only) | none downstream | n/a (terminal) |

All status writes use `updateMany({ where: { id, status: "PROCESSING" } })`
— only the first writer wins; losers match zero rows.

## Money Movement Sequence

1. Re-read status (terminal → replay/return, never re-execute).
2. Check reversal op (`{txid}:reversal`); if present → REVERSED.
3. Check ledger batch; if present → credit recipient (idempotent key),
   conditional COMPLETED.
4. Debit sender (`{txid}:debit`).
5. Post ledger batch; on failure → reversal (`{txid}:reversal`),
   conditional REVERSED, rethrow.
6. Credit recipient (`{txid}:credit`).
7. Conditional COMPLETED + idempotency-key completion, atomically.

## Failure Boundaries (A–J verdicts)

- **A (debit ok, ledger ok):** completes normally. ✓
- **B (debit ok, ledger fails):** reversal + REVERSED; sender net zero,
  recipient zero, no batch. ✓ (integration Test 1)
- **C (ledger timeout, unknown outcome):** treated as failure → reversal
  path. If the batch actually committed, it stays as a *balanced* record
  of an aborted attempt while balances reconcile to zero; status
  REVERSED (never COMPLETED). No money created. ✓ by design.
- **D (status write fails):** row stays PROCESSING; recovery replays via
  the existing-batch branch (credit is idempotent). ✓ (Tests 2/2b)
- **E (response lost):** same-key retry replays the stored body (or 202
  while PROCESSING); never re-executes. ✓
- **F/G (concurrent executors):** **was broken** — fixed by mutual
  exclusion inside `execute()` (below). Previously only
  recovery-vs-recovery was leased; live-vs-recovery could interleave.
- **H (partial then recovery):** covered per branch above. ✓ (Tests
  1b/2/2b/3/4/5)
- **I (same key retried):** P2002 → hash/expiry/payload checks → replay
  or 202. ✓
- **J (crash between ops):** each boundary has a test proving final
  DB state (balances, batch, status). ✓

## Idempotency Strategy

Keys live in `idempotency_keys` (PK = key, 24h expiry): duplicate INSERT
(23505) routes to replay/202/409 paths; payload hash rejects key reuse
with different bodies; every money op carries a deterministic
`{txid}:debit|credit|reversal` key so replays are server-side no-ops.
Recovery uses the same mechanism — no separate path.

## Recovery Strategy

60s in-process tick (5s startup delay, in-flight guard, survives tick
failures, SIGTERM/SIGINT shutdown) scans `PROCESSING` older than 60s and
invokes the same `execute()`. Exclusion is a Redis
`SET key token NX PX 300s` lease **inside `execute()`** (all entry
paths), 60s Lua-guarded heartbeat renewal (downstream HTTP has no
timeouts, so a fixed TTL alone is unsafe), Lua compare-and-delete
release. Contended callers return fresh status without side effects.
Redis outage fails open loudly (pre-existing behavior, idempotency
still absorbs most interleavings).

## Invariants (all verified)

1–2. No creation/destruction: every COMPLETED pairs one debit with one
credit; reversals net to zero (DB-state assertions).
3. One logical transfer per debit/credit pair (op-key counts == 1).
4. Ledger batches always balanced (validator + boundary test).
5–6. Retries and recovery are idempotent (replay + second-recovery
no-op tests).
7. No double-apply under concurrency (deterministic race test).
8. COMPLETED only via the conditional write after durable movement.
9. Failures reconcile (reversal) — no dangling partial debits.
10. Recovery never re-monetizes a finished operation (terminal re-check
    first; reversal-keyed rows are never replayed as live debits).

## Tests

- Existing `crash-recovery.integration.test.ts` (6 tests): sequential
  boundaries with balance/batch/status assertions — all still pass.
- New `concurrent-execution.integration.test.ts`: deterministic
  original-vs-recovery race (gated reversal mock) proving no money
  creation + terminal REVERSED, and double-recovery single movement.
- Rewritten `recovery.test.ts` delegation tests (exclusion now lives in
  `execute()`; lock mechanics still unit-tested against `withRecoveryLock`).

## Tradeoffs

- One Redis round-trip per execution (lease acquire/release) — negligible
  next to the 3+ downstream HTTP calls it guards.
- Contended callers return possibly-stale PROCESSING instead of waiting —
  the next scheduler tick (≤60s) completes them; no slot is ever held
  waiting.
- Fail-open on Redis outage trades exclusion for availability during the
  outage window, loudly logged.

## Known Limitations

- Timeout-less downstream HTTP means a hung dependency stalls the
  holding executor until process death + TTL expiry; adding client
  timeouts would tighten this (not done here).
- `C`-boundary committed-but-reported-failed batches remain as balanced
  records of aborted attempts (audit-visible, financially neutral).
