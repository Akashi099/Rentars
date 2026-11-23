# Rentars

![Backend CI](https://github.com/Rentars/Rentars/actions/workflows/backend-ci.yml/badge.svg)
![Frontend CI](https://github.com/Rentars/Rentars/actions/workflows/frontend-ci.yml/badge.svg)
[![codecov](https://codecov.io/gh/Rentars/Rentars/graph/badge.svg)](https://codecov.io/gh/Rentars/Rentars)

> Decentralized peer-to-peer rental platform built on the [Stellar](https://stellar.org) blockchain.

Rentars is an evolution of [StellarRent](https://github.com/Stellar-Rent/stellar-rent), rebranded and substantially extended. The mission is the same: eliminate rental intermediaries (Airbnb, agencies) through Stellar's fast transactions (~3–5 s), near-zero fees (~$0.000001), and Soroban smart contracts for trustless escrow — but the platform is now a fully featured system, not a scaffold.

---

## Why Rentars?

Traditional rental platforms charge 7–20 % in fees, take 1–7 days to process payments, and exclude small property owners in emerging markets. Rentars addresses this with:

- **Minimal fees** — Stellar's near-zero transaction costs passed directly to users
- **Instant USDC payments** — Payments settle in seconds, not days
- **Trustless escrow** — Soroban smart contracts hold funds until rental conditions are met
- **Full transparency** — Every transaction recorded on Stellar's public ledger
- **No middlemen** — Direct owner-to-tenant relationships

---

## Implemented features

The following are implemented and tested in the current codebase.
"Code-complete" means the feature has automated tests and runs in the CI pipeline.
It does **not** imply deployment-verified or mainnet-ready status — those require the
additional steps in [`DEPLOYMENT.md`](DEPLOYMENT.md) and are tracked separately in
[Deployment-verified capabilities](#deployment-verified-capabilities) below.

### Backend (Node.js / Bun / Express)

| Feature | Status |
|---|---|
| User registration & login (email + password) | ✅ Implemented |
| JWT authentication + refresh tokens | ✅ Implemented |
| Passkey / WebAuthn authentication | ✅ Implemented |
| Freighter wallet authentication (Stellar) | ✅ Implemented |
| Email verification + password reset | ✅ Implemented |
| hCaptcha middleware | ✅ Implemented |
| Role-based access control (host / tenant / admin) | ✅ Implemented |
| Property CRUD with image upload (Supabase Storage) | ✅ Implemented |
| Full-text property search (PostgreSQL GIN index) | ✅ Implemented |
| Geolocation radius search (PostGIS) | ✅ Implemented |
| Search autocomplete & trending searches | ✅ Implemented |
| Search analytics tracking | ✅ Implemented |
| Booking creation, confirmation, cancellation | ✅ Implemented |
| Booking dispute raise & resolution | ✅ Implemented |
| Availability calendar management | ✅ Implemented |
| Dynamic pricing | ✅ Implemented |
| USDC escrow via Trustless Work API | ✅ Implemented |
| Blockchain sync service (Soroban events → DB) | ✅ Implemented |
| Reviews & ratings | ✅ Implemented |
| Notifications (in-app + push) | ✅ Implemented |
| Wishlists | ✅ Implemented |
| Host dashboard & earnings analytics | ✅ Implemented |
| Messaging between host and tenant | ✅ Implemented |
| Redis caching layer | ✅ Implemented |
| Rate limiting (per-route + per-user) | ✅ Implemented |
| Structured logging + Prometheus metrics | ✅ Implemented |
| Admin panel (property moderation, user management) | ✅ Implemented |

### Frontend (Next.js 16)

| Feature | Status |
|---|---|
| Property listing pages with image gallery | ✅ Implemented |
| Advanced search with filters and map view | ✅ Implemented |
| Booking flow with availability calendar | ✅ Implemented |
| Wallet connection (Freighter) + onboarding modal | ✅ Implemented |
| Escrow status tracking UI | ✅ Implemented |
| Host dashboard with calendar management | ✅ Implemented |
| Tenant dashboard with booking history | ✅ Implemented |
| Notification centre | ✅ Implemented |
| Profile management | ✅ Implemented |
| Dark / light theme | ✅ Implemented |
| Offline support (service worker + offline banner) | ✅ Implemented |
| i18n internationalisation scaffolding | ✅ Implemented |
| Responsive design (mobile + desktop) | ✅ Implemented |

### Smart Contracts (Rust / Soroban)

| Contract | Status |
|---|---|
| Property listing contract | ✅ Implemented |
| Booking contract (with escrow lifecycle) | ✅ Implemented |
| Review contract | ✅ Implemented |

### Deployment-verified capabilities

Code-complete is not the same as deployment-verified. The table below records what has
actually been exercised against a live environment. Anything not listed here should be
treated as **unverified in production**.

| Capability | Status | Notes |
|---|---|---|
| Local development stack (backend + frontend + Redis) | ✅ Verified | Documented commands in this README |
| CI pipeline (lint, typecheck, unit/integration tests, build) | ✅ Verified | GitHub Actions on `main` |
| Staging / testnet deployment | ⚠️ Partially verified | Follow [`DEPLOYMENT.md`](DEPLOYMENT.md); verify each step |
| Mainnet deployment | ❌ Not performed | Gated — see [`DEPLOYMENT.md`](DEPLOYMENT.md) |
| Smart contract security audit | ❌ Not performed | Contracts are unaudited |
| Production load / capacity validation | ❌ Not verified | See [`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md) |

### Known limitations

- Mainnet deployment has not been performed. The system targets Stellar testnet.
- Smart contracts have not undergone a third-party security audit.
- Geocoding (latitude/longitude import) requires a configured `GEOCODING_API_KEY`.
- PostGIS must be enabled on the Supabase project before geolocation search works.
- The Stellar CLI and Rust toolchain are required only to build / redeploy contracts, not to run the application.

---

## Monorepo structure

```
rentars/
├── apps/
│   ├── web/                        # Next.js 16 frontend (TypeScript + Tailwind CSS)
│   │   ├── src/
│   │   │   ├── app/                # Next.js App Router pages
│   │   │   ├── components/         # UI components (booking, search, dashboard, …)
│   │   │   ├── hooks/              # React hooks (useProperties, useBookingActions, …)
│   │   │   ├── services/           # API client helpers
│   │   │   ├── context/            # WalletContext
│   │   │   ├── lib/                # Stellar utils, i18n, error handling
│   │   │   └── types/              # Shared TypeScript types
│   │   ├── e2e/                    # Playwright end-to-end tests
│   │   └── package.json
│   │
│   ├── backend/                    # Bun/Node.js Express API
│   │   ├── src/
│   │   │   ├── controllers/        # Request handlers (30+ controllers)
│   │   │   ├── services/           # Business logic (40+ services)
│   │   │   ├── middleware/         # Auth, rate limiting, metrics, CORS, …
│   │   │   ├── routes/             # Express route definitions
│   │   │   ├── blockchain/         # Soroban client wrappers
│   │   │   ├── validators/         # Zod request validators
│   │   │   └── config/             # Supabase, Redis, env config
│   │   ├── database/
│   │   │   └── migrations/         # 50+ SQL migration files
│   │   └── package.json
│   │
│   └── contracts/                  # Soroban smart contracts (Rust)
│       ├── contracts/
│       │   ├── booking/
│       │   ├── property-listing/
│       │   └── review-contract/
│       └── Cargo.toml
│
├── docs/                           # Architecture, capacity planning, incident review
├── tests/                          # Performance test scripts
├── ARCHITECTURE.md                 # Detailed system design
├── DEPLOYMENT.md                   # Testnet and mainnet deployment guide
├── biome.json                      # Linting & formatting config
├── turbo.json                      # Turborepo build pipeline
└── package.json                    # Monorepo root (Yarn workspaces)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS v4, TypeScript |
| Backend | Node.js / Bun runtime, Express 5, TypeScript |
| Database | Supabase (PostgreSQL + Auth + Storage + RLS) |
| Cache | Redis 7 |
| Smart Contracts | Rust, Soroban SDK |
| Blockchain | Stellar (testnet; mainnet-ready) |
| Payments | USDC via Stellar + Trustless Work escrow API |
| Wallet | Freighter API |
| Testing | Vitest (unit/integration), Playwright (e2e) |
| Linting | Biome |
| CI | GitHub Actions |

---

## Prerequisites

| Tool | Version | Required for |
|---|---|---|
| [Bun](https://bun.sh) | ≥ 1.0 | Backend dev and test |
| [Node.js](https://nodejs.org) | ≥ 20 | Frontend and tooling |
| [Yarn](https://yarnpkg.com) | ≥ 1.22 | Workspace management |
| [Supabase account](https://supabase.com) | — | Database and auth |
| [Redis](https://redis.io) | ≥ 7 | Caching (Docker included) |
| [Rust + Cargo](https://rustup.rs) | stable | Contracts only |
| `wasm32-unknown-unknown` Rust target | — | Contracts only |
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) | — | Contracts only |

---

## Getting started

### 1. Clone and install

```bash
git clone https://github.com/Rentars/Rentars.git
cd Rentars
yarn install
```

### 2. Configure environment

```bash
# Backend
cp apps/backend/.env.example apps/backend/.env
# Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET, REDIS_URL,
#           STELLAR_RPC_URL, PROPERTY_LISTING_CONTRACT_ID, BOOKING_CONTRACT_ID,
#           REVIEW_CONTRACT_ID, TRUSTLESS_WORK_API_URL, TRUSTLESS_WORK_API_KEY

# Frontend
cp apps/web/.env.example apps/web/.env.local
# Required: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_STELLAR_NETWORK,
#           NEXT_PUBLIC_SOROBAN_RPC_URL
```

See `apps/backend/.env.example` and `apps/web/.env.example` for the full list of variables.

### 3. Run the development stack

Option A — individual services (from the repo root):

```bash
# Terminal 1: backend (port 3000)
yarn workspace rentars-backend dev

# Terminal 2: frontend (port 3001, per apps/web next.config)
yarn workspace rentars-web dev
```

Option B — full Docker stack (frontend + backend + Redis):

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:3001 |
| Backend API | http://localhost:3000 |
| API health | http://localhost:3000/health |
| Redis | redis://localhost:6379 |

### 4. Apply database migrations

The backend database schema is managed with SQL migration files under
`apps/backend/database/migrations/`. The authoritative bootstrap entrypoint is
`apps/backend/database/setup.sql`, which applies the schema and migrations in order.
Apply it to your Supabase project with `psql` (this is the same path CI uses):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/backend/database/setup.sql
```

`DATABASE_URL` must point at your Supabase Postgres instance (use the connection
string from the Supabase dashboard; never commit it). See [`DEPLOYMENT.md`](DEPLOYMENT.md)
for the complete migration procedure, rollback steps, and verification queries.

---

## Running tests

All commands below are run from the repo root and use the workspace package scripts.

### Backend

```bash
# All tests
yarn workspace rentars-backend test

# Unit tests only
yarn workspace rentars-backend test:unit

# Integration tests
yarn workspace rentars-backend test:integration

# RLS policy tests
yarn workspace rentars-backend test:rls
```

### Frontend

```bash
# Unit and component tests (Vitest)
yarn workspace rentars-web test --run

# End-to-end tests (Playwright — requires a running dev server)
yarn workspace rentars-web e2e

# Visual regression baselines — capture new snapshots
yarn workspace rentars-web exec playwright test e2e/visual-regression.spec.ts --update-snapshots
```

### Contracts

```bash
# Build all Soroban contracts (requires Rust + wasm32-unknown-unknown)
yarn workspace rentars-contracts build
```

---

## API overview

All endpoints are prefixed with `/api/v1`. The full OpenAPI spec is at
`apps/backend/openapi.json`.

| Route group | Example endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/wallet` |
| Properties | `GET /properties`, `GET /properties/:id`, `POST /properties` |
| Search | `GET /properties/search/advanced`, `GET /properties/search/suggestions` |
| Bookings | `POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/dispute` |
| Reviews | `GET /properties/:id/reviews`, `POST /reviews` |
| Notifications | `GET /notifications`, `PATCH /notifications/:id/read` |
| Host | `GET /host/dashboard`, `GET /host/earnings` |
| Wallet | `GET /wallet/connect`, `POST /wallet/auth` |
| Admin | `GET /admin/properties`, `PATCH /admin/users/:id` |
| Health | `GET /health` |

---

## CI/CD

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | Push / PR to `main` | Biome lint, TypeScript check, Bun tests, Next.js build |
| Coverage | Push / PR to `main` | Coverage report uploaded to [Codecov](https://codecov.io/gh/Rentars/Rentars) |

---

## Documentation

| Document | Purpose |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | System design, data flows, database schema, caching strategy |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Testnet and mainnet deployment, rollback, monitoring |
| [`apps/backend/RUNBOOKS.md`](apps/backend/RUNBOOKS.md) | On-call incident response procedures |
| [`docs/INCIDENT_REVIEW_TEMPLATE.md`](docs/INCIDENT_REVIEW_TEMPLATE.md) | Post-incident review template |
| [`docs/RECOVERY_RUNBOOK.md`](docs/RECOVERY_RUNBOOK.md) | Cross-component recovery: DB, storage, Redis, contracts, RPC, email, frontend; monthly drill |
| [`docs/CAPACITY_PLANNING.md`](docs/CAPACITY_PLANNING.md) | Throughput targets, benchmarking, scaling triggers |
| [`docs/SEARCH.md`](docs/SEARCH.md) | Full-text, geolocation, autocomplete, and analytics search guide |
| [`docs/WALLET.md`](docs/WALLET.md) | Freighter wallet connection, passkey, and onboarding guide |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Contribution guidelines |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/): `git commit -m "feat: add property search"`
4. Open a pull request against `main`

This project is inspired by [StellarRent](https://github.com/Stellar-Rent/stellar-rent),
built with the [OnlyDust](https://app.onlydust.com) community.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE)

---

## Acknowledgements

- [StellarRent](https://github.com/Stellar-Rent/stellar-rent) — the original open-source project this is based on
- [Stellar Development Foundation](https://stellar.org) — for Soroban and the Stellar network
- [OnlyDust](https://app.onlydust.com) — open-source contributor community
- [Supabase](https://supabase.com) — backend-as-a-service
- [Trustless Work](https://trustlesswork.com) — escrow API
# Review Integrity and Chain Resilience: Implementation Spec

Two workstreams:

1. **Review integrity**: reviews reflect completed rentals only, one per eligible perspective, no manipulation.
2. **Chain degradation**: RPC/Horizon outages never cause duplicate financial actions or take down read-only features.

**Assumptions** (adjust to the stack): Postgres, TypeScript services, Stellar RPC + Horizon as chain providers, and `bookings`, `users`, `properties` tables as the source of truth.

---



- Booking and user records are the **only authority**. Never trust client-supplied roles, booking state, or dates.
- Every rule is enforced **twice**: in the service (friendly errors) and in the database (hard guarantee).
- A duplicate or ineligible attempt **fails safely**: no partial writes, no rating changes, a clear error code.
- Eligibility is defined in **one place**, and the API and DB constraints derive from it.

### 1.2 Eligibility Model

A review is a `(booking_id, reviewer_role)` pair. Each booking has at most two perspectives:

| Perspective | Reviewer | Subject | Affects property rating? |
|---|---|---|---|
| `guest_to_host` | booking guest | property/host | Yes |
| `host_to_guest` | property host | guest | No (guest reputation only) |

**Rules (all must pass):**

1. **Booking completed.** The stay actually finished (see 1.3).
2. **Participant relationship.** The reviewer is the booking's `guest_id` or the property's `host_id`, and the role matches the relationship.
3. **Review window.** `checkout_at <= now <= checkout_at + 14 days`.
4. **One per perspective.** One review per `(booking_id, reviewer_role)`.
5. **Not self-dealing.** `guest_id != host_id`, and neither account is flagged as linked to the other.
6. **Account standing.** The reviewer isn't suspended or banned.

### 1.3 Booking State Eligibility Matrix

Define booking statuses: `pending`, `confirmed`, `in_progress`, `completed`, `cancelled`, `refunded`, `modified`, `disputed`.

| Booking state | Guest review | Host review | Notes |
|---|---|---|---|
| `completed` (no refund, no dispute) | ✅ | ✅ | Normal path |
| `completed` + partial refund | ✅ | ✅ | Stay happened; refund is a settlement detail |
| `refunded` (full, stay occurred) | ✅ flagged `refund_full` | ✅ | Allowed, excluded from rating if policy says so |
| `refunded` (full, stay never occurred) | ❌ | ❌ | No rental happened |
| `cancelled` before check-in | ❌ | ❌ | No rental happened |
| `cancelled` after check-in (early checkout) | ✅ | ✅ | Eligible only if `actual_nights >= 1` |
| `modified` | Depends | Depends | Judge by the **final** dates; the amended booking must complete |
| `disputed` (open) | ❌ (held) | ❌ (held) | Reviews blocked until resolution |
| `disputed` (resolved) | ✅ per outcome | ✅ per outcome | See below |
| `pending` / `confirmed` / `in_progress` | ❌ | ❌ | Not completed |

**Dispute resolution outcomes:**

- `resolved_for_guest`: guest may review; host review allowed but flagged.
- `resolved_for_host`: both may review.
- `resolved_split`: both may review.
- `withdrawn`: treat as underlying completed state.

**Edge cases:**

- A booking modified *after* checkout is not valid. Modifications are locked at `checkout_at`.
- If a booking is refunded or disputed *after* a review exists, don't delete the review. Set `moderation_status = 'under_review'` and exclude it from aggregates until resolved.
- Review window clock starts at **actual** checkout, not scheduled checkout, when early checkout is recorded.

### 1.4 Data Model

#### Migration: reviews table

```sql
-- 001_reviews.sql
CREATE TYPE review_role AS ENUM ('guest_to_host', 'host_to_guest');
CREATE TYPE review_moderation AS ENUM ('published', 'under_review', 'removed');

CREATE TABLE reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid        NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  property_id        uuid        NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  reviewer_id        uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewer_role      review_role NOT NULL,
  rating             smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body               text        NOT NULL CHECK (char_length(body) BETWEEN 10 AND 4000),
  moderation_status  review_moderation NOT NULL DEFAULT 'published',
  flags              text[]      NOT NULL DEFAULT '{}',
  idempotency_key    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- THE core guarantee: one review per perspective per booking
  CONSTRAINT reviews_one_per_perspective UNIQUE (booking_id, reviewer_role),

  -- reviewer can never review themselves
  CONSTRAINT reviews_no_self_review CHECK (reviewer_id <> subject_user_id)
);

CREATE INDEX reviews_property_published_idx
  ON reviews (property_id)
  WHERE moderation_status = 'published' AND reviewer_role = 'guest_to_host';

CREATE UNIQUE INDEX reviews_idempotency_idx
  ON reviews (reviewer_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

#### Booking prerequisites

```sql
-- 002_booking_review_fields.sql
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS checkout_actual_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at       timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_status     text
    CHECK (dispute_status IN ('none','open','resolved_guest','resolved_host','resolved_split','withdrawn'))
    DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS refund_kind        text
    CHECK (refund_kind IN ('none','partial','full_after_stay','full_no_stay'))
    DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS review_window_days smallint NOT NULL DEFAULT 14;
```

### 1.5 Database-Level Enforcement

The unique constraint stops duplicates. Eligibility needs a trigger so even a direct SQL insert or a buggy service can't bypass it.

```sql
-- 003_review_eligibility_trigger.sql
CREATE OR REPLACE FUNCTION assert_review_eligible() RETURNS trigger AS $$
DECLARE
  b            bookings%ROWTYPE;
  p            properties%ROWTYPE;
  ended_at     timestamptz;
  window_end   timestamptz;
BEGIN
  SELECT * INTO b FROM bookings WHERE id = NEW.booking_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REVIEW_BOOKING_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO p FROM properties WHERE id = b.property_id;

  -- property consistency
  IF NEW.property_id <> b.property_id THEN
    RAISE EXCEPTION 'REVIEW_PROPERTY_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  -- participant relationship + role match
  IF NEW.reviewer_role = 'guest_to_host' THEN
    IF NEW.reviewer_id <> b.guest_id OR NEW.subject_user_id <> p.host_id THEN
      RAISE EXCEPTION 'REVIEW_NOT_PARTICIPANT' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW.reviewer_id <> p.host_id OR NEW.subject_user_id <> b.guest_id THEN
      RAISE EXCEPTION 'REVIEW_NOT_PARTICIPANT' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- booking state
  IF b.status NOT IN ('completed','cancelled','refunded','modified') THEN
    RAISE EXCEPTION 'REVIEW_BOOKING_NOT_COMPLETED' USING ERRCODE = 'P0001';
  END IF;

  IF b.dispute_status = 'open' THEN
    RAISE EXCEPTION 'REVIEW_BOOKING_DISPUTED' USING ERRCODE = 'P0001';
  END IF;

  IF b.refund_kind = 'full_no_stay' THEN
    RAISE EXCEPTION 'REVIEW_NO_STAY_OCCURRED' USING ERRCODE = 'P0001';
  END IF;

  IF b.status = 'cancelled' AND b.checkout_actual_at IS NULL THEN
    RAISE EXCEPTION 'REVIEW_NO_STAY_OCCURRED' USING ERRCODE = 'P0001';
  END IF;

  -- window
  ended_at   := COALESCE(b.checkout_actual_at, b.checkout_at);
  window_end := ended_at + make_interval(days => b.review_window_days);

  IF now() < ended_at THEN
    RAISE EXCEPTION 'REVIEW_TOO_EARLY' USING ERRCODE = 'P0001';
  END IF;
  IF now() > window_end THEN
    RAISE EXCEPTION 'REVIEW_WINDOW_CLOSED' USING ERRCODE = 'P0001';
  END IF;

  -- flags derived from booking state, never from client
  IF b.refund_kind = 'full_after_stay' THEN
    NEW.flags := array_append(NEW.flags, 'refund_full');
  END IF;
  IF b.dispute_status = 'resolved_guest' AND NEW.reviewer_role = 'host_to_guest' THEN
    NEW.flags := array_append(NEW.flags, 'dispute_resolved_against_reviewer');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_eligibility
  BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION assert_review_eligible();

-- reviews are immutable in identity fields
CREATE OR REPLACE FUNCTION reviews_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.booking_id <> OLD.booking_id
     OR NEW.reviewer_id <> OLD.reviewer_id
     OR NEW.reviewer_role <> OLD.reviewer_role
     OR NEW.property_id <> OLD.property_id THEN
    RAISE EXCEPTION 'REVIEW_IMMUTABLE_FIELDS' USING ERRCODE = 'P0001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reviews_immutable_trg
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_immutable();
```

**Consistency note:** the trigger and the service must agree. Both read from the shared eligibility function (1.6) and the same status matrix. A test (1.9) asserts they never diverge.

### 1.6 Service Layer

#### Single source of eligibility

```ts
// review-eligibility.ts
export type ReviewRole = 'guest_to_host' | 'host_to_guest';

export type EligibilityReason =
  | 'ok'
  | 'booking_not_found'
  | 'not_participant'
  | 'booking_not_completed'
  | 'booking_disputed'
  | 'no_stay_occurred'
  | 'too_early'
  | 'window_closed'
  | 'already_reviewed'
  | 'account_restricted'
  | 'linked_accounts';

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  role?: ReviewRole;
  flags: string[];
  windowEndsAt?: Date;
}

export function evaluateEligibility(input: {
  booking: BookingRecord;
  property: PropertyRecord;
  reviewer: UserRecord;
  existingRoles: ReviewRole[];
  linkedAccounts: boolean;
  now: Date;
}): EligibilityResult {
  const { booking, property, reviewer, existingRoles, linkedAccounts, now } = input;

  const role: ReviewRole | null =
    reviewer.id === booking.guestId ? 'guest_to_host'
    : reviewer.id === property.hostId ? 'host_to_guest'
    : null;

  if (!role) return deny('not_participant');
  if (reviewer.status !== 'active') return deny('account_restricted', role);
  if (linkedAccounts) return deny('linked_accounts', role);

  if (!['completed', 'cancelled', 'refunded', 'modified'].includes(booking.status))
    return deny('booking_not_completed', role);
  if (booking.disputeStatus === 'open') return deny('booking_disputed', role);
  if (booking.refundKind === 'full_no_stay') return deny('no_stay_occurred', role);
  if (booking.status === 'cancelled' && !booking.checkoutActualAt)
    return deny('no_stay_occurred', role);

  const endedAt = booking.checkoutActualAt ?? booking.checkoutAt;
  const windowEnd = new Date(endedAt.getTime() + booking.reviewWindowDays * 86_400_000);
  if (now < endedAt) return deny('too_early', role);
  if (now > windowEnd) return deny('window_closed', role);

  if (existingRoles.includes(role)) return deny('already_reviewed', role);

  const flags: string[] = [];
  if (booking.refundKind === 'full_after_stay') flags.push('refund_full');

  return { eligible: true, reason: 'ok', role, flags, windowEndsAt: windowEnd };
}

function deny(reason: EligibilityReason, role?: ReviewRole): EligibilityResult {
  return { eligible: false, reason, role, flags: [] };
}
```

#### Submission flow

```ts
// review-service.ts
export async function submitReview(
  ctx: { userId: string },          // from authenticated session ONLY
  dto: { bookingId: string; rating: number; body: string },
  idempotencyKey?: string,
) {
  return db.transaction(async (tx) => {
    // Lock the booking row to serialize concurrent submissions per booking.
    const booking = await tx.bookings.findByIdForUpdate(dto.bookingId);
    if (!booking) throw new ReviewError('booking_not_found', 404);

    const [property, reviewer, existing, linked] = await Promise.all([
      tx.properties.findById(booking.propertyId),
      tx.users.findById(ctx.userId),
      tx.reviews.rolesForBooking(booking.id),
      accountsLinked(tx, booking.guestId, booking.hostIdFor(property)),
    ]);

    const decision = evaluateEligibility({
      booking, property, reviewer,
      existingRoles: existing, linkedAccounts: linked, now: new Date(),
    });
    if (!decision.eligible) throw new ReviewError(decision.reason, statusFor(decision.reason));

    try {
      const review = await tx.reviews.insert({
        bookingId: booking.id,
        propertyId: property.id,
        reviewerId: reviewer.id,
        subjectUserId: decision.role === 'guest_to_host' ? property.hostId : booking.guestId,
        reviewerRole: decision.role!,
        rating: dto.rating,
        body: sanitize(dto.body),
        flags: decision.flags,
        idempotencyKey,
      });
      await enqueueAggregateRecompute(tx, property.id);
      return review;
    } catch (e) {
      // DB is the final authority. Map its errors; never leak raw SQL errors.
      throw mapDbError(e);
    }
  });
}
```

#### Error mapping

```ts
const HTTP: Record<string, number> = {
  booking_not_found: 404,
  not_participant: 403,
  account_restricted: 403,
  linked_accounts: 403,
  booking_not_completed: 409,
  booking_disputed: 409,
  no_stay_occurred: 409,
  too_early: 409,
  window_closed: 410,
  already_reviewed: 409,
};

function mapDbError(e: any): ReviewError {
  if (e.code === '23505' && e.constraint === 'reviews_one_per_perspective')
    return new ReviewError('already_reviewed', 409);
  if (e.code === '23505' && e.constraint === 'reviews_idempotency_idx')
    return new ReviewError('already_reviewed', 409); // replay: caller fetches original
  if (e.message?.startsWith('REVIEW_'))
    return new ReviewError(e.message.slice(7).toLowerCase() as EligibilityReason, 409);
  throw e;
}
```

#### Idempotency

If the same `Idempotency-Key` repeats from the same user, return the **original review** with `200`, not an error. A genuine second attempt without the key gets `409 already_reviewed`.

### 1.7 Anti-Manipulation Controls

Eligibility alone doesn't stop coordinated fraud. Layer these on:

- **Linked-account detection.** Flag accounts sharing payment instruments, wallet addresses, device fingerprints, or IP clusters. Block (`linked_accounts`) on strong signals; flag for moderation on weak ones.
- **Wallet relationship check.** If guest and host wallets have transacted outside platform bookings, flag the review.
- **Velocity limits.** More than N reviews per reviewer per 24h → hold for moderation.
- **Booking quality signals.** Minimum stay length, minimum booking value, and booking-to-review time anomalies feed a `suspicion_score`.
- **Held, not rejected.** Suspicious reviews insert as `under_review`, invisible to aggregates until cleared. Never tell the reviewer *why*.
- **Aggregates count only** `moderation_status = 'published' AND reviewer_role = 'guest_to_host'`.

### 1.8 API Contract

#### `POST /v1/bookings/:bookingId/reviews`

Request:

```json
{ "rating": 5, "body": "Clean, quiet, exactly as described." }
```

Headers: `Idempotency-Key: <uuid>` (recommended).

Never accept `reviewer_id`, `role`, or `property_id` from the client.

Responses:

| Status | `code` | Meaning |
|---|---|---|
| 201 | n/a | Review created |
| 200 | n/a | Idempotent replay |
| 403 | `not_participant` | Not part of this booking |
| 404 | `booking_not_found` | |
| 409 | `already_reviewed` | Duplicate perspective |
| 409 | `booking_not_completed` / `booking_disputed` / `no_stay_occurred` / `too_early` | |
| 410 | `window_closed` | |

#### `GET /v1/bookings/:bookingId/review-eligibility`

Returns the same `EligibilityResult` for the current user, so the UI shows or hides the review prompt using the **same logic** as submission. Never compute eligibility in the frontend.

### 1.9 Testing

#### Unit: eligibility matrix

Table-driven, one row per cell in 1.3:

```ts
test.each([
  ['completed', 'none', 'none', 'guest_to_host', true],
  ['completed', 'partial', 'none', 'guest_to_host', true],
  ['refunded', 'full_no_stay', 'none', 'guest_to_host', false],
  ['refunded', 'full_after_stay', 'none', 'guest_to_host', true],
  ['cancelled', 'none', 'none', 'guest_to_host', false],
  ['completed', 'none', 'open', 'host_to_guest', false],
  ['completed', 'none', 'resolved_host', 'host_to_guest', true],
  ['in_progress', 'none', 'none', 'guest_to_host', false],
])('%s / refund %s / dispute %s / %s → %s', (...) => { /* ... */ });
```

#### Boundary tests

- Exactly at `checkout_at` and at `window_end` (inclusive edges)
- One second before and after each edge
- Early checkout shifts the window
- Timezone/DST: all comparisons in UTC

#### Authorization tests

- Third-party user → `403`
- Guest submitting as `host_to_guest` → ignored/rejected (role derived, not accepted)
- Host of a *different* property → `403`
- Suspended reviewer → `403`

#### Race and repeat tests (the important ones)

```ts
test('50 concurrent identical submissions → exactly one row', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () => submitReview(guestCtx, dto)),
  );
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await countReviews(booking.id, 'guest_to_host')).toBe(1);
  results
    .filter(r => r.status === 'rejected')
    .forEach(r => expect((r as any).reason.code).toBe('already_reviewed'));
});

test('guest + host submit simultaneously → two rows, one each', async () => { /* ... */ });

test('booking becomes disputed mid-submission → submission serialized by row lock', async () => { /* ... */ });

test('retry with same Idempotency-Key returns original review', async () => { /* ... */ });

test('direct SQL insert bypassing service still rejected by trigger', async () => {
  await expect(rawInsert({ bookingId: incompleteBooking.id, /* ... */ }))
    .rejects.toThrow(/REVIEW_BOOKING_NOT_COMPLETED/);
});

test('service and trigger agree across the full matrix', async () => {
  for (const scenario of allScenarios) {
    const svc = evaluateEligibility(scenario.input).eligible;
    const db  = await tryRawInsert(scenario.fixture);
    expect(db.ok).toBe(svc);
  }
});
```

#### Safe-failure assertions

After every rejected attempt: no review row, no aggregate change, no outbox event, and the transaction rolled back.

### 1.10 Acceptance Checklist (Part 1)

- [ ] Only the booking guest or property host can submit, in the matching role
- [ ] Exactly one review per `(booking, role)`, enforced by a DB unique constraint
- [ ] Refunded, cancelled, modified, and disputed bookings follow the matrix
- [ ] Review window enforced in both service and trigger
- [ ] Concurrent and repeated submissions fail safely with `already_reviewed`
- [ ] Service and trigger decisions proven consistent by test
- [ ] Aggregates exclude `under_review`/`removed` and host-to-guest reviews
- [ ] Client never supplies role, reviewer, or property

---

## Part 2: Chain Degradation Handling

### 2.1 Principles

- **Reads degrade gracefully; writes degrade safely.** Stale data beats no data. Duplicate money movement is never acceptable.
- **Ambiguity is a state, not an error.** A timed-out broadcast is "unknown," never "failed."
- **Never rebroadcast without reconciling first.**
- **Blast radius is feature-scoped.** Chain trouble must not take down browsing, search, messaging, or reviews.

### 2.2 Chain Health State

#### States

| State | Meaning | Trigger |
|---|---|---|
| `healthy` | All providers OK | Default |
| `degraded` | Partial impairment (elevated latency, one provider down, ledger lag) | Soft thresholds crossed |
| `outage` | No usable provider | Hard thresholds crossed / all breakers open |
| `recovering` | Providers returning, reconciliation running | Breaker half-open + pending work exists |

#### Signals (per provider: RPC, Horizon)

- Request success rate (rolling 60s)
- p95 latency
- Latest ledger age (`now - closed_at`; stale ledger means network or provider lag)
- Consecutive failures
- Cross-provider ledger disagreement (>N ledgers apart)

```ts
export interface ProviderHealth {
  name: 'rpc' | 'horizon';
  state: 'closed' | 'open' | 'half_open';  // breaker state
  successRate: number;
  p95Ms: number;
  latestLedger: number | null;
  latestLedgerAgeSec: number | null;
  consecutiveFailures: number;
  lastChangeAt: Date;
}

export interface ChainHealth {
  status: 'healthy' | 'degraded' | 'outage' | 'recovering';
  providers: ProviderHealth[];
  since: Date;
  pendingSubmissions: number;
  message: string;     // user-safe
}
```

#### State derivation

```ts
export function deriveStatus(p: ProviderHealth[], pending: number): ChainHealth['status'] {
  const open = p.filter(x => x.state === 'open').length;
  const halfOpen = p.some(x => x.state === 'half_open');

  if (open === p.length) return 'outage';
  if (pending > 0 && (halfOpen || open < p.length) && wasRecentlyImpaired()) return 'recovering';
  if (open > 0 || p.some(x => x.p95Ms > 5000 || (x.latestLedgerAgeSec ?? 0) > 60))
    return 'degraded';
  return 'healthy';
}
```

Use **hysteresis**: enter `degraded` fast (2-3 bad samples), leave slowly (several consecutive good samples over 30-60s) to prevent flapping.

### 2.3 Circuit Breakers

One breaker per provider **and** per operation class (reads vs. submits), so read failures don't open the submit breaker.

```ts
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 15_000,
    private readonly halfOpenProbes = 1,
  ) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.cooldownMs) throw new BreakerOpenError();
      this.state = 'half_open';
    }
    try {
      const r = await fn();
      this.onSuccess();
      return r;
    } catch (e) {
      if (isProviderFault(e)) this.onFailure();   // NOT business errors (e.g. tx_bad_seq)
      throw e;
    }
  }

  private onSuccess() { this.failures = 0; this.state = 'closed'; }
  private onFailure() {
    this.failures++;
    if (this.state === 'half_open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
```



- **Provider fault** (counts toward breaker): timeouts, 5xx, connection reset, 429, stale ledger.
- **Business/network rejection** (does *not* count): bad sequence, insufficient balance, op failure, validation errors.

**Failover:** if multiple RPC/Horizon endpoints are configured, try the next healthy provider for **reads**. For **submits**, see 2.6 (only fail over after reconciling).

### 2.4 Action Classification

Every chain-touching feature must be registered in one of four classes. This registry drives breakers, UI restrictions, and queue behavior.

| Class | Description | Examples | Degraded | Outage |
|---|---|---|---|---|
| **R0: No chain** | Pure DB/product features | Browse, search, messages, reviews, profile | ✅ normal | ✅ normal |
| **R1: Cached read** | Chain data, staleness tolerable | Balances display, property price in XLM, history | ✅ live→cache | ✅ cache + "stale" label |
| **R2: Live read required** | Decision depends on fresh state | Pre-booking availability/escrow check, quote | ⚠️ retry/failover | ❌ disabled |
| **W1: Safe to queue** | Idempotent, provably safe to delay | Status sync, indexer backfill, notification of tx result, metadata anchor | ✅ queue | ✅ queue |
| **W2: Unsafe mutation** | Moves money / irreversible | Pay booking, release escrow, refund, withdraw, token transfer | ⚠️ restricted | ❌ disabled |

**Rule for W1:** an operation may be queued only if (a) it's idempotent by key, (b) executing it later cannot cause financial harm, and (c) its preconditions are re-validated at execution time. **Default is W2 (unsafe)** until proven otherwise.

```ts
export const ACTION_REGISTRY = {
  'booking.pay':            { class: 'W2', needs
