# Backend Test Suite

A complete picture of every test type in the Rentars backend, how to run each one,
and what it protects against.

---

## Quick reference

| Script | Files | What it covers |
|---|---|---|
| `bun run test:unit` | `tests/unit/**` | Services, validators, utilities — no HTTP |
| `bun run test:contract` | `tests/contract.test.ts` | OpenAPI schema + status-code contract |
| `bun run test:property-based` | `tests/unit/property-based.test.ts` | Generative invariant tests |
| `bun run test:concurrency` | `tests/integration/concurrency.test.ts` | Race-condition + availability correctness |
| `bun run test:performance` | `tests/integration/booking-performance.test.ts` | Arrival-rate scenario, latency/error targets, saturation, DB lock + Redis telemetry |
| `bun run test:journey` | `tests/integration/booking-journey.test.ts` | Full booking lifecycle E2E |
| `bun run test:e2e` | `tests/integration/booking-e2e.test.ts` | Legacy booking lifecycle (mocked) |
| `bun run test:rls` | `tests/rls/**` | Row Level Security (live Supabase) |
| `bun run test:integration` | `tests/integration/**` | All integration tests |
| `bun test --coverage` | `src/**`, `tests/**` | Full suite with coverage report |

All tests use **Bun** as the runtime (`bun test`). No Node.js or Jest binary is required.

---

## Test types

### Unit tests — `tests/unit/`

Unit tests for individual services and functions. Supabase, blockchain, and email
dependencies are mocked — no running server required.

Covers: booking service, auth service, property service, availability, calendar,
pricing, refund policy, notifications, reviews, sync, ICS generation, validators,
rate limiter, audit logs, email layout, preference tokens, and migration validation.

```bash
cd apps/backend
bun run test:unit
```

---

### OpenAPI contract tests — `tests/contract.test.ts`

Validates that every documented critical endpoint matches the OpenAPI 3.0 spec at
`openapi.json`. Uses AJV to compile component schemas and assert response shapes.

**What it catches:**
- Response body that does not match the documented JSON Schema.
- HTTP status codes that are not listed in the spec's `responses` map (undocumented
  status codes are treated as breaking changes).
- Missing `application/json` Content-Type header.
- Regression against known error envelope shapes (`{ error: string }` or
  `{ error: { code, message } }`).

**Endpoints covered:**
`GET /health` · `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` ·
`POST /auth/password-reset/request` · `GET /properties` · `GET /properties/:id` ·
`GET /properties/search/advanced` · `POST /properties` · `POST /bookings` ·
`GET /bookings` · `GET /bookings/:id` · `PATCH /bookings/:id` · `DELETE /bookings/:id` ·
`POST /bookings/:id/confirm` · `POST /bookings/:id/cancel` · `POST /payments/submit` ·
`GET /payments/:id/status` · `POST /payments/:id/retry` · `GET /notifications` ·
`GET /notifications/preferences` · `POST /messages` · `GET /admin/dashboard` ·
`GET /admin/users` · `GET /admin/bookings` · `GET /admin/disputes` ·
`GET /admin/audit-logs` · `GET /exchange-rates` · `GET /policy/current` · `GET /api/v2`

**Running:**
```bash
cd apps/backend
bun run test:contract
```

**Adding a new endpoint to the contract:**
1. Add the path and response schemas to `openapi.json`.
2. Add a `describe` block in `tests/contract.test.ts` following the existing pattern.
3. If the endpoint has a documented `200` shape, add an `assertShape` call for it.

**Breaking-change policy:**
A PR that changes a documented response schema or removes a documented status code
will cause contract tests to fail. To introduce a breaking change:
- Bump the API version to `/api/v2` and keep the v1 path alive during the
  deprecation window (see `docs/api-versioning.md`), or
- Get explicit approval from the platform team and update `openapi.json` in the
  same PR.

---

### Property-based (generative) tests — `tests/unit/property-based.test.ts`

Tests domain invariants with a lightweight inline `forAll` harness. Uses an
xorshift32 RNG seeded from `Date.now()` so failures are reproducible: the failing
input and seed are printed in the error message and can be added to the
"Regression seeds" section at the bottom of the file.

**Domains covered:**

| Domain | Invariant |
|---|---|
| Refund policy | `refundAmount >= 0` for all inputs |
| Refund policy | `refundAmount <= totalPrice` |
| Refund policy | `refundPct ∈ [0, 1]` |
| Refund policy | Tier is monotone in `hoursUntilCheckIn` |
| Refund policy | Partial tier = `totalPrice × partialRefundPct` (± 0.02) |
| Refund policy | Same inputs → same output (deterministic) |
| Date ordering | `checkOut > checkIn` for all valid pairs |
| Date ordering | Inverted pairs always flagged |
| Date ordering | Stay ≥ 1 night for valid pairs |
| Amount arithmetic | `nights × rate = total`, total > 0 |
| Amount arithmetic | `refundAmount` has ≤ 2 decimal places (no float drift) |
| Booking validator | Negative / zero / fractional `guest_count` always rejected |
| Booking validator | Inverted dates always rejected |
| Booking validator | Invalid UUIDs for `property_id` always rejected |
| Booking validator | Negative `total_price` always rejected |
| Booking validator | Every required field, when omitted, produces a validation error |
| Booking validator | Invalid status strings always rejected by `updateBookingSchema` |
| Auth validator | Emails without `@` always rejected |
| Auth validator | Passwords < 12 chars always rejected |
| Auth validator | Passwords without uppercase / digit / special char always rejected |
| Pagination | Page windows are non-overlapping and contiguous |
| Pagination | Negative / zero page rejected; `pageSize > 100` rejected |
| State machine | Terminal states (Completed, Cancelled) have no successors |
| State machine | Every successor is a known status |
| State machine | No status can transition to itself |
| Unauthorized mutation | Non-tenant can never cancel another user's booking |
| Stellar address | Valid addresses always match `/^G[A-Z2-7]{55}$/` |

**Running:**
```bash
cd apps/backend
bun run test:property-based
```

**Adding a new invariant:**
```typescript
it('my new invariant always holds', () => {
  forAll(
    'invariant label',
    myGenerator(),
    (value) => {
      // return false or throw to fail
      return myInvariant(value);
    },
    200, // sample count
  );
});
```

**Reproducing a failure:**
Copy the seed from the error output and pass it as the fifth argument to `forAll`:
```typescript
forAll('...', gen, property, 200, 0xdeadbeef); // deterministic replay
```
Then add the minimal failing case to the "Regression seeds" describe block.

---

### Concurrency tests — `tests/integration/concurrency.test.ts`

Fires multiple simultaneous HTTP requests against the same Express app instance
to verify availability correctness and latency under concurrent load.

**Infrastructure:** Fully in-memory mock Supabase with an atomic overlap-detection
function mirroring `create_booking_atomic_v2`. No live Supabase or Redis required.

**Suites:**

| Suite | Concurrency | What it asserts |
|---|---|---|
| Exclusive booking | 5 tenants | Exactly 1 booking created; all others → 409 |
| Exclusive booking | 10 tenants | Exactly 1 booking created; DB has 1 row |
| Conflict error shape | 2 tenants | 409 response includes `error` field |
| Partial overlap | 2 tenants | Overlapping-by-days produces 409 |
| Adjacent windows | 2 tenants | Check-out day = next check-in day both succeed |
| Ghost hold | 2 tenants | Cancelled booking frees slot for next tenant |
| Delete frees slot | 2 tenants | Deleted booking frees slot |
| Independent properties | 2 tenants | Same dates on different properties both succeed |
| Non-overlapping windows | 5 tenants | 5 separate 3-day windows all succeed |
| Idempotency key | 2 calls | Duplicate Idempotency-Key returns original response |
| Latency budget | 5 concurrent | Every request completes within 500 ms |
| Health latency | 1 call | `/health` responds within 100 ms |
| Escrow count | 5 tenants | Only 1 escrow created for N competing attempts |
| No leaked escrows | 2 tenants | `cancelEscrow` not called for pre-conflict failures |

**Running:**
```bash
cd apps/backend
bun run test:concurrency
```

**Extending with real infrastructure:**
The mock can be replaced with a live local Supabase instance (e.g. `supabase start`)
by setting `SUPABASE_URL=http://localhost:54321` and removing the mock override of
`supabase`. The latency budget assertions may need widening for network overhead.

---

### Booking journey E2E — `tests/integration/booking-journey.test.ts`

A deterministic end-to-end test that exercises the full booking lifecycle from
both the **tenant** and **host** perspectives across 10 sequential phases.

Every phase asserts:
- The HTTP response status and body shape.
- The in-memory DB state matches the response at that point.
- The `X-Request-Id` correlation header is present (required for tracing).

**Run isolation:**
All seeded data is prefixed with a unique `RUN_ID` (`journey-{timestamp}-{random}`)
generated at test invocation. Parallel CI runs never collide. Phase 10 asserts no
data leaked outside the run namespace.

**Phases:**

| Phase | Actor | Steps |
|---|---|---|
| 0 — Health | — | `GET /health` is 200 before the journey starts |
| 1 — Search & Discover | Tenant | List properties, property detail, price quote, advanced search |
| 2 — Create Booking | Tenant | 401 (no auth), 400 (inverted dates), 400 (no rules), **201 success**, 409 (duplicate) |
| 3 — Read & List | Tenant | Read by ID, list bookings, 404 non-existent, 401 unauthenticated |
| 4 — Observe | Host | Read booking, check availability, occupancy heatmap (auth + unauth) |
| 5 — Confirm | Tenant | `POST /confirm` → Confirmed; double-confirm → 400; host sees Confirmed |
| 6 — Complete | Tenant | `POST /complete` → Completed; post-completion invariants (400 cancel, 400 re-confirm) |
| 7 — Artifacts | Tenant | ICS calendar download, PDF receipt, 403 for third party |
| 8 — Cancellation | Tenant | New booking → 401 cancel → cancel → 409 double-cancel → rebook freed slot |
| 9 — Notifications | — | Notifications exist in-memory; all carry booking ID |
| 10 — Isolation | — | All IDs have RUN_ID prefix; final status is Completed; escrow attached |

**Running:**
```bash
cd apps/backend
bun run test:journey
```

**Failure diagnosis:**
Each `it` block contains a human-readable label with the HTTP method, path, and
expected status. When a test fails, the error includes:
- The response body (for shape mismatches).
- The DB row state at the time of failure.
- The phase and step name, which identifies the layer (validator, service, controller).

---

### RLS policy tests — `tests/rls/`

Integration tests that connect to a **live local Supabase stack** as different
authenticated users and verify that Row Level Security policies block cross-user
data access.

**Prerequisites:**
```bash
supabase start
```

**Env vars** (set in `.env.test`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

```bash
cd apps/backend
bun run test:rls
```

Tables covered: `profiles`, `bookings`, `wishlists`, `notifications`, `properties`,
`property_images`.

---

### API shell tests — `tests/api/`

Shell-based endpoint smoke tests using `curl`. Require the backend running on
`http://localhost:3000`.

```bash
cd apps/backend
bun run dev          # in one terminal
bun run test:api     # in another terminal
```

---

### Docker integration tests — `tests/docker/`

Full-stack integration tests using Docker Compose. Require Docker installed.

```bash
bash tests/docker/integration.test.sh
```

---

## CI integration

All test suites run in GitHub Actions CI on every push and pull request to
`main`, `master`, and `develop`. The pipeline has 10 jobs:

| Job | Trigger | Depends on live infra? |
|---|---|---|
| `validate-migrations` | All PRs | No |
| `unit-tests` | All PRs | No |
| `backend-e2e` | All PRs | No (mocked) |
| `rls-tests` | All PRs | Yes (Supabase Docker service) |
| `contract-tests` | All PRs | No (mocked) |
| `property-based-tests` | All PRs | No |
| `concurrency-tests` | All PRs | No (in-memory) |
| `journey-tests` | All PRs | No (in-memory) |
| `frontend-e2e` | All PRs | No (intercepted routes) |
| `docs-link-check` | All PRs | No |

All jobs run in parallel except where step ordering within a job requires
sequential execution.

---

## Coverage

The coverage threshold (enforced in `jest.config.js` for reference, and applied
by `bun test --coverage`) requires **80 %** on branches, functions, lines, and
statements across `src/**`.

```bash
cd apps/backend
bun test --coverage
```

An LCOV report is written to `./coverage/` and can be uploaded to Codecov or
viewed locally with any LCOV browser.

---

## Contributing

When adding a new endpoint:
1. Document it in `openapi.json` with all possible `responses` status codes.
2. Add a `describe` block in `tests/contract.test.ts`.
3. If the endpoint has financial, date, or auth logic — add invariants to
   `tests/unit/property-based.test.ts`.
4. If the endpoint is part of the booking lifecycle — add a phase or step to
   `tests/integration/booking-journey.test.ts`.
5. Run the full suite locally before opening a PR:
   ```bash
   bun run test:contract && bun run test:property-based && bun run test:concurrency && bun run test:journey && bun run test:unit
   ```
