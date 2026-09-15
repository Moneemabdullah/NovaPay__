# NovaPay — API Security & Resource Protection

## Problem

Two systematic input gaps: requests with no JSON body crashed route
destructuring into 500s (leaking a `TypeError`), and malformed IDs
(e.g. non-UUID wallet IDs) crashed Prisma validation into 500s whose
messages embedded server filesystem paths.

## Why It Matters

500s on bad input burn alerting budgets, confuse clients, and leak
internals. Validation failures must be 400s with stable, path-free
bodies — before any database or money-movement code runs.

## Architecture

```
request → auth (401/403) → body normalize → route validation (400)
        → Prisma (client-validation errors mapped to 400) → handler
```

## Definitions

- **Body normalization**: missing bodies become `{}` for methods that
  carry payloads, so every route's own validation produces its 400.
- **Prisma client-validation mapping**: `PrismaClientValidationError`
  (malformed scalars/UUIDs, caught client-side before any query)
  becomes `400 VALIDATION_ERROR` with a fixed message.
- **Existing layers kept**: helmet headers, per-route checks
  (currencies, amounts, idempotency keys), history `limit`/`cursor`
  bounds, payroll batch cap — untouched.

## Current Implementation

- `app.addHook("preValidation", …)` in all 7 `src/app.ts`: undefined
  bodies on POST/PUT/PATCH become `{}`.
- All 7 `src/middlewares/error-handler.ts`: `PrismaClientValidationError`
  → 400 with a fixed, path-free message.
- History endpoint: `walletId` required, `limit` 1–100 (default 50),
  opaque cursors rejected when malformed (`transaction-service`).
- Payroll batches capped at 5000 items; Nginx 10 MB edge cap
  (`docs/REQUEST_SIZE_LIMITS.md`).

## Failure Behavior

| Input | Before | After |
|---|---|---|
| POST with no body | 500 `TypeError` | route's own 400 |
| Non-UUID ID | 500 + server path leak | 400, fixed message |
| Over-limit pagination | 400 (already) | unchanged |
| Oversized payroll batch | 400 (already) | unchanged |

## Security Considerations

- No stack traces, file paths, SQL, secrets, or PII in error bodies;
  5xx paths log server-side with redaction intact.
- Rate limiting deliberately **not** implemented: idempotency keys
  absorb replay floods, and per-instance in-memory limits without an
  auth identity to key on would be theater. Revisit with Redis-backed
  limits if abuse is ever observed.
- CORS stays closed (no plugin = browser cross-origin blocked by
  default); same-origin assessment client unaffected.

## Testing

Unit suites assert 400 (not 500) for missing bodies and malformed IDs
per service, plus the pre-existing validation suites. Verified live
probes during development returned the 500s above before the fix.

## Tradeoffs

- Generic normalization instead of per-route body schemas: smaller
  diff, uniform behavior; per-route Zod schemas remain a future option.
- No request logging of bodies (PII-safe by construction).

## Limitations

- Genuine 500s still echo `error.message` (no stack, but Prisma runtime
  messages can name constraints) — acceptable, logged server-side.
- No global request-size cap inside Fastify beyond its 1 MB default;
  Nginx remains the edge bound.
