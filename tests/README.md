# Rentars — Testing Infrastructure

Complete testing strategy for Rentars: unit, integration, E2E, contract, performance, and security.

---

## Architecture Overview

| Layer | Tool | Location | Runner |
|---|---|---|---|
| Backend unit tests | Bun test | `apps/backend/tests/unit/` | `bun run test:unit` |
| Backend integration tests | Bun test + Supertest | `apps/backend/tests/integration/` | `bun run test:integration` |
| Backend RLS tests | Bun test | `apps/backend/tests/rls/` | `bun run test:rls` |
| Backend contract tests | Bun test | `apps/backend/tests/contract/` | `bun run test:contract` |
| Backend property-based tests | Bun test | `apps/backend/tests/property-based/` | `bun run test:property-based` |
| Backend concurrency tests | Bun test | `apps/backend/tests/concurrency/` | `bun run test:concurrency` |
| Backend journey tests | Bun test | `apps/backend/tests/journey/` | `bun run test:journey` |
| Backend performance tests | Bun test | `apps/backend/tests/performance/` | `bun run test:performance` |
| Frontend unit tests | Vitest + Testing Library | `apps/web/src/**/*.test.tsx` | `yarn test --run` |
| Frontend E2E tests | Playwright | `apps/web/e2e/` | `yarn e2e` |
| Visual regression | Playwright snapshots | `apps/web/e2e/visual-regression.spec.ts` | `yarn e2e --update-snapshots` |
| Soroban contract tests | cargo test | `apps/contracts/contracts/*/src/test.rs` | `cargo test` |
| Performance tests | K6 | `tests/performance/k6/` | `k6 run` |
| Security scanning | OWASP ZAP + Gitleaks + CodeQL | CI only | Automated |

---

## Quick Start

### Backend

```bash
cd apps/backend

# All tests
bun test

# Unit only
bun run test:unit

# Integration only
bun run test:integration

# RLS policies
bun run test:rls

# Contract tests
bun run test:contract

# Property-based tests
bun run test:property-based

# Concurrency tests
bun run test:concurrency

# Journey tests
bun run test:journey

# Performance tests
bun run test:performance

# With coverage (lcov + text)
bun test --coverage --coverage-reporter=lcov --coverage-dir=./coverage
```

### Frontend

```bash
cd apps/web

# All tests
yarn test --run

# Watch mode
yarn test

# With coverage
yarn test --run --coverage

# E2E tests (requires the dev server running on :3000)
yarn e2e

# E2E specific browser
yarn e2e --project=chromium

# Visual regression (update snapshots)
yarn e2e e2e/visual-regression.spec.ts --update-snapshots
```

### Smart Contracts

```bash
cd apps/contracts

# All contracts
cargo test

# Specific contract
cd contracts/booking && cargo test

# With output
cargo test -- --nocapture
```

### Performance Tests (K6)

```bash
# Install K6: https://grafana.com/docs/k6/latest/get-started/installation/

# Smoke test (quick sanity check)
k6 run tests/performance/k6/smoke-test.js

# Load test (50 VUs sustained)
k6 run tests/performance/k6/api-load-test.js

# Stress test (up to 300 VUs)
k6 run tests/performance/k6/booking-stress-test.js

# Against staging
k6 run -e BASE_URL=https://api.staging.rentars.io tests/performance/k6/api-load-test.js
```

---

## Coverage Targets

| Component | Threshold |
|---|---|
| Backend services | ≥ 80% lines/branches/functions |
| Frontend components | ≥ 80% lines/branches/functions |
| Smart contracts | Rust inline tests |

---

## CI/CD Pipeline

```
push/PR → main
│
├── lint (Biome)
├── typecheck (tsc)
│
├── backend-tests (Bun)   ─── 80% coverage gate
├── frontend-tests (Vitest) ─── 80% coverage gate
├── contract-tests (cargo)  ─── all tests pass
│
├── build (Turborepo)
│
└── On main merge:
    ├── e2e-tests (Playwright — chromium/firefox/webkit)
    ├── coverage (Codecov upload)
    ├── security (CodeQL + Gitleaks + cargo-audit)
    └── performance (K6 smoke — nightly full load)
```

---

## Security Scanning

| Tool | What it checks |
|---|---|
| **Gitleaks** | Secrets committed to git history |
| **CodeQL** | Static analysis for JS/TS security vulnerabilities |
| **cargo-audit** | Known vulnerabilities in Rust dependencies |
| **yarn audit** | Known vulnerabilities in Node.js dependencies |
| **OWASP ZAP** | Runtime API security scan (scheduled/manual) |
| **OSSF Scorecard** | Supply chain security posture (main branch) |

---

## Test Data & Mocks

- `apps/backend/tests/mocks/supabase.mock.ts` — chainable Supabase mock (bun:test)
- `apps/backend/tests/mocks/supabase.mock.data.ts` — fixture data for properties/bookings/users
- `apps/backend/tests/mocks/blockchain.mocks.ts` — blockchain service mocks
- `apps/web/src/tests/setup.ts` — global Vitest setup (Next.js router, Supabase, Freighter mocks)
- `apps/web/src/tests/utils/test-utils.tsx` — custom render with providers

---

## Performance Benchmarks

Established baselines from K6 load tests:

| Endpoint | p95 Target | p99 Target |
|---|---|---|
| `GET /health` | < 50ms | < 100ms |
| `GET /api/properties` | < 500ms | < 1000ms |
| `GET /api/properties/:id` | < 400ms | < 800ms |
| `POST /api/bookings` | < 2000ms | < 3000ms |
| `GET /api/reviews` | < 500ms | < 1000ms |

Error rate target: < 1% under normal load, < 5% under stress.
