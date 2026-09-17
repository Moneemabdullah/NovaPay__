# NovaPay — Transaction History Pagination

## Problem

Transaction history had no read endpoint at all, and the naive future
shape — `findMany({ where: { wallet } })` returning every row — would run
an unbounded live query over a growing `transactions` table on every page
load: unbounded memory, unbounded latency, and no stable position when new
rows arrive mid-browse.

## Definitions

- **Transaction history** — completed and in-flight transactions where a
  wallet is sender or recipient, newest first.
- **Offset pagination** — `SKIP n TAKE m`: simple, but later pages rescan
  skipped rows and shift when rows arrive.
- **Keyset pagination** — `WHERE row is strictly after cursor ORDER BY
  stable-sort TAKE m+1`: cost independent of page depth.
- **Cursor** — opaque base64url token carrying the last row's sort
  position (`createdAt` + `id`).
- **Stable ordering** — `createdAt DESC, id DESC`: total (timestamps can
  tie; UUID `id` never does).
- **Composite cursor** — position on two columns, required because one
  timestamp is not unique.
- **Page size** — default 50, hard maximum 100.

## Existing Problem

No `GET /transactions` existed (only `POST /transactions`,
`/transfers/international`, `/international`, `/internal/recover`).
The `transactions` table had only single-column indexes (`status`,
`sender_wallet_id`, `recipient_wallet_id`, `created_at`) — nothing
serving a wallet-scoped ordered page.

## Architecture

```mermaid
flowchart LR
    Client["Client"]
    Gateway["API Gateway<br/>/transactions prefix"]
    Service["Transaction Service<br/>GET /transactions"]
    Postgres[("PostgreSQL")]
    Query["Indexed History Query<br/>Composite Index per Side"]
    Page["Pagination<br/>limit + 1 · No COUNT(*)"]

    Client --> Gateway --> Service --> Postgres --> Query --> Page

    classDef edge fill:#ffffff,stroke:#2563eb,stroke-width:2px,color:#111827
    classDef service fill:#ffffff,stroke:#16a34a,stroke-width:2px,color:#111827
    classDef database fill:#ffffff,stroke:#d97706,stroke-width:2px,color:#111827

    class Client,Gateway edge
    class Service,Query,Page service
    class Postgres database

    linkStyle default stroke:#64748b,stroke-width:2px
```

## Pagination Design

Keyset, not offset: page cost stays flat at any depth and concurrent
inserts never shift or duplicate rows mid-traversal (new rows sort before
the cursor and appear on a fresh first page, never inside an in-flight
traversal). No previous-page support (product doesn't need it).

- First page: `ORDER BY createdAt DESC, id DESC LIMIT n+1`.
- Next page: `WHERE (createdAt < c.createdAt OR (createdAt =
  c.createdAt AND id < c.id))` + same order + `LIMIT n+1`.
- `hasMore = rows.length > limit`; `nextCursor` from the last item, else
  `null`. The extra row replaces `COUNT(*)` entirely.
- Cursor is base64url JSON `{createdAt, id}` — no account data, and the
  wallet-ownership filter is always applied server-side, so forged
  cursors cannot widen results. Malformed cursors → 400.

## Query Design

```ts
prisma.transaction.findMany({
  where: { AND: [
    { OR: [{ senderWalletId: w }, { recipientWalletId: w }] },
    ...(cursor ? [{ OR: [
      { createdAt: { lt: cursorDate } },
      { createdAt: cursorDate, id: { lt: cursor.id } },
    ]}] : []),
  ]},
  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  take: limit + 1,   // explicit select, never SELECT *
})
```

Response exposes `id`, wallet IDs, stringified amounts/rate, status, and
ISO timestamps only — `requestHash`, `failureReason`, and
`idempotencyKey` stay internal. Money fields serialize BigInt/Decimal to
strings (ledger convention).

## Index Design

Two composite indexes (migration `0002_history_indexes`):

```sql
CREATE INDEX idx_transactions_sender_created_id
  ON transactions(sender_wallet_id, created_at DESC, id DESC);
CREATE INDEX idx_transactions_recipient_created_id
  ON transactions(recipient_wallet_id, created_at DESC, id DESC);
```

Why: the query is an OR of two wallet-equality branches sharing one
`(createdAt, id)` ordering. Each branch needs equality-first, then the
order columns — hence one index per branch. Column order follows use:
wallet equality narrows to ~10² rows, the rest serves order + cursor
range directly (observed as index-only scans per branch).

## Security

`walletId` is required — an unfiltered scan is impossible by construction.
Ownership is re-asserted on every page (cursor included). UUID `id`
values are unique tiebreakers, never secrets; cursors carry no PII.
This matches the codebase's existing walletId-param authorization model
(no auth layer exists yet — history inherits it, neither weakens nor
invents one).

## Consistency

No snapshot guarantee is claimed. New rows sort before any live cursor,
so an in-flight traversal never duplicates or skips: it simply won't
show rows created after it started (visible on refresh). Status
transitions on already-returned rows don't affect positioning
(`createdAt`/`id` are immutable).

## Performance Verification

Scratch DB (`history_perf`, real migrations), 20,000 rows across 200
wallets (~227 rows for the busiest wallet), 100 deliberately identical
timestamps. Measured with `EXPLAIN (ANALYZE, BUFFERS)`:

- **First page** (227-row wallet): BitmapOr over the wallet indexes +
  top-N heapsort (30 kB), 173 buffers hit, **2.07 ms**, no sequential
  scan.
- **Deep page** (cursor at row 150): same shape, **2.29 ms**.
- **Single-branch cursor query**: `Index Only Scan using
  idx_transactions_sender_created_id`, no sort node at all.

No fabricated numbers: these are the observed plans on the seeded set.
Cost grows with one wallet's history, never with table size.

## Tests

`test/history.test.ts` (mocked `findMany` faithfully emulating the
AND/OR/cursor/order/take contract — a query-shape change fails loudly):
page size, default/max limits, multi-page traversal with zero
duplicates/skips, identical-timestamp tiebreaks, exact-multiple and
empty pages, wallet isolation incl. forged cursors, field allow-list,
opaque round-trip, and route-level 400s (bad cursor, bad limit, missing
wallet). One real emulator bug (Date-equality branch) was caught by the
full suite and fixed — the mock now mirrors Prisma equality semantics.

## Tradeoffs

- Keyset chosen over OFFSET: flat deep-page cost, no skip/duplicate
  under concurrent inserts; price is no direct page-number jumps and a
  slightly subtler client contract.
- Two composite indexes instead of one: forced by the sender/recipient
  OR — each branch needs its own equality-first ordering.
- Millisecond cursor precision: `Date` round-trips lose sub-millisecond
  parts. Groups sharing an identical timestamp traverse exactly via the
  `id` tiebreaker; ordering stays total and deterministic regardless.

## Future Scaling

If single-wallet histories reach millions of rows: read replicas for
history traffic, time-based table partitioning, or a dedicated read
model. None are warranted now — the indexed keyset query is flat.
