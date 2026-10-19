# Contributing to Rentars

## Quick reference

| Task | Command |
|---|---|
| Install all deps | `yarn install` |
| Start full stack | `yarn dev` |
| Lint (check) | `yarn lint` |
| Lint + autofix | `yarn lint:fix` |
| Format | `yarn format` |
| All tests | `yarn test` |
| Backend unit tests | `yarn workspace rentars-backend test:unit` |
| Backend integration tests | `yarn workspace rentars-backend test:integration` |
| Frontend tests (single run) | `yarn workspace web test --run` |
| Validate DB migrations | `yarn workspace rentars-backend validate:migrations` |
| Seed database | `yarn workspace rentars-backend db:seed` |
| Build all | `yarn build` |

---

## Getting Started

1. Fork the repository.
2. Clone your fork:

   ```bash
   git clone https://github.com/yourusername/Rentars.git
   cd Rentars
   ```

3. Install all workspace dependencies from the repo root:

   ```bash
   yarn install
   ```

   > **Note:** The project uses **Yarn 1 (Classic)** workspaces. Do not use `npm install` or `bun install`
   > at the root — they will ignore the workspace layout.

---

## Prerequisites

| Tool | Required version | Purpose |
|---|---|---|
| Node.js | ≥ 20 | Frontend build & root scripts |
| [Bun](https://bun.sh) | ≥ 1.0 | Backend runtime & test runner |
| Yarn | ≥ 1.22 | Workspace package manager |
| Rust + Cargo | stable | Soroban smart contracts |
| `wasm32-unknown-unknown` target | — | Contract WASM compilation |
| [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/stellar-cli) | latest | Contract deployment |
| [Supabase](https://supabase.com) project | — | Database + Auth |

Install the Rust WASM target:

```bash
rustup target add wasm32-unknown-unknown
```

---

## Development Setup

### Backend

```bash
cd apps/backend
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET (min 32 chars),
# STELLAR_NETWORK, TRUSTLESS_WORK_API_URL, TRUSTLESS_WORK_API_KEY
bun run dev        # starts with --watch on port 3000
```

### Frontend

```bash
cd apps/web
cp .env.example .env.local
# Fill in NEXT_PUBLIC_API_URL=http://localhost:3000
yarn dev           # starts Next.js on port 3001 (or next available port)
```

### Both at once (from repo root)

```bash
yarn dev
# Runs backend (blue) and frontend (green) concurrently via `concurrently`
```

### Full stack with Docker

```bash
# Copy env files first
cp apps/backend/.env.example apps/backend/.env
cp apps/web/.env.example apps/web/.env.local

# Start all services (backend, frontend, Redis)
docker-compose up --build

# Development mode with hot-reload volumes
docker-compose -f docker-compose.yml -f docker-compose.override.yml up
```

| Service | URL | Port |
|---|---|---|
| Frontend | http://localhost:3001 | 3001 |
| Backend API | http://localhost:3000 | 3000 |
| Redis | redis://localhost:6379 | 6379 |

---

## Database

### Apply migrations

Migrations live in `apps/backend/database/migrations/`. They are SQL files with a
`NNNNN_description.sql` naming convention. Apply them via the Supabase dashboard or CLI:

```bash
supabase db reset    # applies all migrations to the local Supabase stack
```

### Naming new migrations

New migration files **must** use the next sequential five-digit prefix. Check the highest
existing prefix before adding a file. Duplicate prefixes fail the `validate:migrations` CI job:

```bash
yarn workspace rentars-backend validate:migrations
```

### Seed data

```bash
yarn workspace rentars-backend db:seed
```

---

## Smart Contracts (Rust / Soroban)

```bash
cd apps/contracts

# Build all contracts to WASM
cargo build --target wasm32-unknown-unknown --release

# Run contract unit tests (pure Rust, no Stellar network needed)
cargo test

# Deploy to Stellar Testnet (requires Stellar CLI + funded testnet account)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/rental_contract.wasm \
  --network testnet \
  --source <YOUR_SECRET_KEY>
```

---

## Code Quality

Rentars uses **Biome** for both linting and formatting (replaces ESLint + Prettier).

```bash
# Check everything (run before pushing)
yarn lint

# Fix auto-fixable issues and reformat
yarn lint:fix

# Format only (no lint)
yarn format
```

The `biome.json` at the repo root configures 2-space indentation, single quotes, and
trailing commas. Run `yarn lint` in CI to catch regressions.

### Pre-commit hook

A `.husky/pre-commit` hook exists, but `husky` and `lint-staged` are **not currently
installed** as root dependencies, so the hook is inert on a clean checkout. Always run
lint and format yourself before pushing:

```bash
yarn lint
yarn format
```

If you re-enable the hook, install the missing tooling first:

```bash
yarn add -D husky lint-staged
```

---

## Testing

### Backend

The backend uses **Bun's built-in test runner**. Test files live under
`apps/backend/src/__tests__/` (unit) and `apps/backend/tests/` (integration/e2e/RLS).

```bash
# Run all backend tests
yarn workspace rentars-backend test

# Unit tests only (fast, no network/DB required)
yarn workspace rentars-backend test:unit

# Integration / E2E tests (mocked Supabase + TrustlessWork)
yarn workspace rentars-backend test:integration

# Booking E2E lifecycle test
yarn workspace rentars-backend test:e2e

# RLS policy tests (requires a running local Supabase stack)
yarn workspace rentars-backend test:rls

# Shell-based API smoke tests (requires a running backend on port 3000)
yarn workspace rentars-backend test:api

# Generate lcov coverage report
yarn workspace rentars-backend test:coverage
```

> **Watch mode:** Bun's test runner does not have a `--watch` flag that works identically to
> Vitest. Use `bun run --watch src/index.ts` for the dev server instead.

### Frontend

The frontend uses **Vitest** for unit/component tests and **Playwright** for E2E.

```bash
# Single run (CI-safe, no watch mode)
yarn workspace web test --run

# Watch mode (local development)
yarn workspace web test:watch

# Coverage
yarn workspace web test:coverage

# Playwright E2E (requires a built Next.js app)
yarn workspace web e2e

# Specific E2E suite
yarn workspace web e2e:journey
```

### CI jobs (`.github/workflows/ci.yml`)

| Job | What it does |
|---|---|
| `runtime-check` | Verifies Node/Bun/Yarn versions via `scripts/check-engines.sh` |
| `release-validation` | Validates `CHANGELOG.md` via `yarn release:validate` |
| `validate-migrations` | Checks migration filenames for duplicate/out-of-order prefixes |
| `unit-tests` | Backend unit tests via Bun (no external services) |
| `backend-e2e` | Full booking lifecycle with mocked Supabase + TrustlessWork |
| `rls-tests` | Row-level security policies against a local Supabase Postgres |
| `contracts` | Builds and tests the Soroban contracts |
| `frontend-checks` | Frontend lint and unit tests |
| `frontend-e2e` | Playwright search → booking journey on Chromium |
| `docs-link-check` | Fails on broken internal documentation links |

All jobs run on every push or PR to `main`, `master`, or `develop`.

### Lockfile note

Use **Yarn 1** so `yarn.lock` is the canonical lockfile. If a clean checkout only has
`package-lock.json`, run `yarn install` once to regenerate `yarn.lock`, then commit it.
Do not commit `npm install` output.

---

## Branching & Pull Requests

- Branch from `main` and open PRs back to `main`.
- Branch naming convention: `feat/short-description`, `fix/short-description`, `docs/…`, `chore/…`
- Keep PR titles under 70 characters. Use the description for context.
- Include a **testing evidence** section in the PR body (which test commands you ran).
- At least one review is required before merging.
- Squash-merge to keep the commit history clean.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add property wishlisting
fix: resolve booking conflict on same-day check-in
docs: update contributing commands
refactor: extract refund policy into service
test: add cancellation refund tier tests
chore: bump biome to 1.9.4
```

---

## Release Process

Releases are managed **manually** — there is no automated Changesets or npm-publish workflow.

1. Bump the version in the relevant `package.json` (root or workspace).
2. Add an entry to `CHANGELOG.md` following the existing format, then validate:

   ```bash
   yarn release:validate      # scripts/validate-changelog.ts
   yarn release:manifest      # scripts/generate-release-manifest.ts
   ```

   Both run in the `release-validation` CI job.
3. Open a PR titled `chore: release vX.Y.Z`.
4. After merge, create a GitHub Release and tag (`vX.Y.Z`).

> There is no `yarn changeset` command in this repository. Do not add changeset files.

---

## Troubleshooting

### `bun` not found

Bun is required to run backend scripts and tests. Install it:

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then restart your terminal and verify: `bun --version`.

### `rustup` / `cargo` not found

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
```

### `yarn install` fails with peer-dependency errors

Use `--ignore-engines` as a last resort:

```bash
yarn install --ignore-engines
```

### Supabase local stack won't start

Supabase requires Docker. Make sure Docker Desktop is running, then:

```bash
supabase start
```

If you see port conflicts, check `supabase status` and stop other services on ports 54321/54322.

### Pre-commit hook fails with "lint-staged not found"

Run `yarn install` from the repo root to ensure all dev dependencies are installed, then try
committing again.

### Migration validation fails in CI

You added a migration with a duplicate prefix. Rename the file to use the next sequential
number (check the highest existing prefix in `apps/backend/database/migrations/`). See
`apps/backend/database/MIGRATIONS_NAMING.md` for the canonical ordering rules.

---

## Questions?

Open an issue for discussion before submitting a PR. Tag it `question` if you are unsure
whether something is a bug or intended behavior.
