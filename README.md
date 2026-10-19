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
"Production-certified" means the feature has automated tests and runs in the CI pipeline.
It does not imply mainnet deployment, which requires the additional steps in [`DEPLOYMENT.md`](DEPLOYMENT.md).

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

Option A — individual services:

```bash
# Terminal 1: backend (port 3000)
cd apps/backend
bun run dev

# Terminal 2: frontend (port 3001)
cd apps/web
yarn dev
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
`apps/backend/database/migrations/`. Apply them to your Supabase project via the
Supabase SQL editor or using `psql`:

```bash
psql -U postgres -d rentars -f apps/backend/database/setup.sql
```

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the complete migration procedure.

---

## Running tests

### Backend

```bash
cd apps/backend

# All tests
bun test

# Unit tests only
bun test tests/unit

# Integration tests
bun test tests/integration

# RLS policy tests
bun test tests/rls
```

### Frontend

```bash
cd apps/web

# Unit and component tests (Vitest)
yarn test --run

# End-to-end tests (Playwright — requires a running dev server)
yarn e2e

# Visual regression baselines — capture new snapshots
npx playwright test e2e/visual-regression.spec.ts --update-snapshots
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
