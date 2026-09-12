# NovaPay — PII Encryption Posture and Focused Business-Logic Tests

## PART 1 — PII Encryption: Why There Is Intentionally No Decrypt API

### Problem

`account-service` encrypts user PII on write. Review asked whether a
decrypt/read path was missing. Audit verdict: **no legitimate read path
requires plaintext, so no decrypt function exists — by design, not by
omission.** Adding one would widen the PII exposure surface for zero
business value.

### Existing Encryption Architecture

Envelope encryption (AES-256-GCM throughout) in
`account-service/src/services/crypto.service.ts` (`envelope()`):

1. A random 32-byte per-record DEK encrypts `fullName` (and `phone` if
   present), each with its own random 12-byte IV; GCM auth tags stored.
2. The DEK is wrapped with the KEK: `SHA-256(FIELD_ENCRYPTION_KEK)` used as
   an AES-256-GCM key with a fresh IV; stored as
   `wrapped = iv(12) + authTag(16) + encryptedDek(32)` (60 bytes total).

### Data Flow

```
POST /users ──▶ envelope(fullName, phone) ──▶ users row ──▶ 201 {id, email, createdAt}
   (plaintext          (ciphertext + IVs + tags                (PII never
    in, never           + wrapped DEK persisted)                 returned)
    stored)
```

`createUser` (`wallet.service.ts`) persists `fullNameEnc/Iv/Tag`,
`phoneEnc/Iv/Tag`, `dekWrapped` and returns only `{id, email, createdAt}`.
Wallet/balance flows operate on IDs and amounts — never on names/phones.
**No route, service, or query in the repository selects the encrypted
columns back** (verified by grep; the logger redacts `dekWrapped`).

### Key Management

- KEK sourced from `FIELD_ENCRYPTION_KEK` env var (required, `min(1)`),
  stretched with a single SHA-256 into the wrapping key on every call.
- DEKs are random per record and never stored unwrapped.
- Rotation story (unchanged): re-wrap DEKs under the new KEK; no field
  re-encryption needed.

### Ciphertext Format (pinned by `test/crypto-envelope.test.ts`)

| Field | Bytes |
|---|---|
| name/phone IV | 12 (random per encryption) |
| name/phone auth tag | 16 (GCM) |
| `dekWrapped` | 60 = iv(12) + tag(16) + encDEK(32) |

Encryption is nondeterministic: identical plaintext never yields identical
bytes (fresh IV + fresh DEK each call).

### Security Properties

- Authenticated encryption: any bit-flip in ciphertext, IV, tag, or
  wrapped DEK fails GCM verification on unwrap (no silent corruption).
- Compromise of one record's DEK exposes only that record.
- Plaintext and keys are never logged (logger redaction list covers
  `dekWrapped`; `createUser` never returns PII).

### Failure / Tampering Behavior

There is no decrypt path to fail — tampered rows are inert blobs. If a
future legitimate read requirement emerges, decryption must unwrap-then-
decrypt with tag verification, reject malformed input, and return plaintext
only to the narrowly-scoped caller (never logs, never bulk responses).

### What May Be Decrypted, and Where

Nothing, today. The only acceptable future readers would be explicitly
authorized flows (e.g. regulatory disclosure, user data export), each
wired to use the single crypto module — never duplicated logic.

## PART 2 — Focused Tests: `applyWalletOperation` and `consumeQuote`

### Why These Two Functions

- `applyWalletOperation` is the money-movement primitive: every debit and
  credit funnels through its single atomic `UPDATE ... WHERE status='active'
  AND balance + delta >= 0` guarded by an idempotency record. A bug here is
  a money bug.
- `consumeQuote` is the single-use gate for FX value: its atomic
  `UPDATE ... WHERE used=false AND expires_at>now()` is the only thing
  standing between a quote and double-spend.

### Invariants Covered

- Balances never go negative; inactive/missing wallets change nothing and
  record nothing (service returns `null` → route maps to 422).
- Replayed operation keys return the current wallet without a second
  balance mutation (idempotency).
- A quote is consumable exactly once; repeats, used, and expired quotes
  are distinguishable (`consumed` flag + `used` flag) so routes can return
  404 vs `409 ALREADY_USED` vs `409 EXPIRED`.
- DB failures propagate (never swallowed into fake success); service-level
  non-integer amounts throw via `BigInt` even if route validation is
  bypassed.

### Test Boundaries

- Pure unit tests with a mocked `prisma` singleton (`vi.mock`), real
  `Prisma.sql`/`Prisma.Decimal` — SQL strings and value mapping stay real,
  only the transport is fake. No Docker/Postgres needed.
- Route-level 400 validation for wallet operations via `app.inject`
  (no DB hit — validation precedes the service call).
- Neither service has an integration config, and behavior under test is
  fully determined by mocked query results; no integration tests added.

### Confidence Provided

The suites prove the exact rows-created/rows-matched logic (`create`
called once on success, never on guard failure), replay safety, error
propagation, and quote single-consumption — the properties a money and
FX audit cares about — without depending on live infrastructure.
