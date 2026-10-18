# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — 2026-10-18

#### #735 — Reproducible development and CI installs
- Added `apps/contracts/rust-toolchain.toml` pinning Rust 1.82.0 with
  `wasm32-unknown-unknown` target and `clippy`/`rustfmt` components; rustup
  and the contracts CI job now both use the exact declared version.
- Updated `.nvmrc` from a loose `20` to the exact pinned version `20.18.0`
  matching `.tool-versions`.
- Pinned all CI jobs to `node-version: '20.18.0'` and `bun-version: '1.1.38'`
  (previously `node-version: '20'` and `bun-version: latest`).
- Updated contracts CI job from `dtolnay/rust-toolchain@stable` to
  `dtolnay/rust-toolchain@master` with explicit `toolchain: '1.82.0'` so the
  runner uses the version declared in `rust-toolchain.toml`.

#### #734 — Release versioning across applications and contracts
- Added `scripts/check-abi-migration-changelog.sh` — fails a PR when contract
  ABI files (`apps/contracts/*.json`) or migration SQL files
  (`apps/backend/database/migrations/*.sql`) change without a corresponding
  `CHANGELOG.md` update; enforces explicit release notes for schema or ABI
  changes.
- Added `Check ABI and migration changes are documented` step to the
  `release-validation` CI job; the job now runs with `fetch-depth: 0` so the
  diff against the base branch is always available.
- Added `docs/releases/compatibility.md` — documents what to write in
  the changelog for additive vs. breaking ABI/schema changes, explains
  the release manifest fields, and specifies the rollout order requirement
  for breaking changes.

#### #733 — Deployment preview smoke tests with environment identity
- Added `deployment_id` and `environment` inputs to
  `.github/workflows/smoke-tests.yml`; failures now carry
  `[env=<name> deploy=<id>]` annotations so the broken deployment is
  identifiable without inspecting CI logs.
- Added `Publish smoke test summary` step that writes environment, deployment
  ID, API/frontend URLs, status, and run link to the GitHub Actions job summary.
- Updated artifact name to include environment and deployment ID for
  unambiguous identification across concurrent deployments.
- Updated `apps/web/e2e/smoke.spec.ts` to prefix every assertion failure
  message with `[env=... deploy=...]` context from `SMOKE_DEPLOYMENT_ID`
  and `SMOKE_ENVIRONMENT` environment variables.

#### #732 — Dependency and secret scanning gates
- Added `apps/contracts/.cargo/audit.toml` — per-finding suppression config
  for `cargo audit`; each suppressed advisory requires a reason, expiry date,
  and GitHub issue link; the CI job now passes `--config .cargo/audit.toml`
  explicitly.

### Added — 2026-09-25

#### #576 — Reproducible lockfile and runtime checks
- Added `.nvmrc` pinning Node 20 and `.tool-versions` for asdf/mise with exact
  Node, Bun, and Rust versions.
- Added `scripts/check-engines.sh` — validates Node, Yarn, Bun, and Rust versions
  before install/build; exits 1 with a clear error when a runtime is unsupported.
- Added `engines:check` and `versions` scripts to root `package.json`.
- Added `runtime-check` CI job that enforces `--frozen-lockfile` installs for
  root, backend, and web workspaces and runs `check-engines.sh`.

#### #575 — Release versioning and changelog automation
- Added `scripts/validate-changelog.ts` — enforces that CHANGELOG.md has an
  `[Unreleased]` section with at least one recognised category heading and that
  every versioned section carries a release date.
- Added `scripts/generate-release-manifest.ts` — generates a machine-readable
  `docs/releases/manifest-<version>.json` recording commit SHA, image tag,
  per-component versions, latest migration, ABI SHA-256 hashes, and rollback
  documentation pointer.
- Added `docs/releases/rollback.md` — runbook for selecting and applying a prior
  release manifest during a rollback.
- Added `release:validate` and `release:manifest` scripts to root `package.json`.
- Added `release-validation` CI job that validates CHANGELOG.md and runs the
  manifest generator on every push and pull request.

#### #574 — Preview environment smoke tests
- Added `GET /api/v1/readiness` — lightweight process-readiness probe used by
  smoke tests immediately after a cold deploy; does not probe dependencies.
- Added `apps/web/e2e/smoke.spec.ts` — post-deploy smoke suite validating backend
  readiness, health endpoint availability, CORS policy, unauthenticated property
  search shape, frontend page load, and browser-to-backend connectivity.
- Added `.github/workflows/smoke-tests.yml` — workflow triggered manually or via
  `workflow_call` after deployment; uploads a Playwright report as an artifact.
- No real bookings, escrow side effects, or persistent data are created by the
  smoke suite outside its isolated test scope.

#### #573 — Dependency and secret scanning
- Added `.github/workflows/security-scan.yml` — runs on every PR and nightly:
  - `secret-scan`: gitleaks full-history scan + self-test that detects the
    planted fixture key.
  - `yarn-audit`: audits root and web workspaces at `--level high`.
  - `bun-audit`: audits backend workspace.
  - `cargo-audit`: audits contracts workspace via `cargo-audit`.
  - `container-scan`: trivy filesystem scan of backend and web at HIGH/CRITICAL.
- Added `.gitleaks.toml` — extends gitleaks defaults; suppresses publicly
  documented Supabase local-dev demo JWTs; excludes lockfiles and the fixture.
- Added `tests/fixtures/secret-detection.fixture.txt` — intentionally planted
  fake AWS key used as a CI self-test to prove the scanner detects secrets.
- Added `.trivyignore` — placeholder for approved CVE exceptions with expiry.
- Added `docs/security-exceptions.md` — exception process, severity thresholds,
  and suppression format for each scanning tool.

### Added — 2026-Q3 roadmap review (2026-09-23)

This entry records the quarterly roadmap review output.
All decisions below replace the previously undifferentiated TODO material.

#### Issue tracking and backlog governance
- Added `.github/ISSUE_TEMPLATE/` with three structured templates:
  `bug_report.yml`, `feature_request.yml`, and `task.yml`.
  Every template requires owner, priority (P0–P3), area, scope, and
  acceptance criteria.  Bug reports also capture source file references.
- Added `ROADMAP.md` as the single source of truth for planned work,
  sprint blockers, and quarterly review instructions.
- Defined stale-item policy: 90 days no-activity → labelled `stale`;
  closed 14 days later unless updated by a maintainer.
- Identified current sprint blockers: dispute resolution frontend (#112),
  PostGIS migration deployment, and mainnet contract audit.
- Migrated previously generic TODO checklist items to appropriate
  roadmap sections (Q4 2026 milestone and unscheduled backlog).
  The 450-item generic template appended to TODO.md has been removed;
  it was not Rentars-specific work.

#### Internationalisation and currency policy
- Created `docs/I18N_CURRENCY_POLICY.md` defining:
  - Supported locales (en, es, fr, pt active; ar and de planned Q1 2027).
  - Settlement currency is always USDC; `total_price` in `bookings` is USDC only.
  - Display-currency conversions are informational; every conversion shows
    the USDC source amount and rate timestamp.
  - Stale exchange-rate handling: show USDC prominently; warn user;
    do not fabricate precision.
  - Precision rules (Intl.NumberFormat only; no toFixed() on amounts).
  - Translation ownership table; fallback behaviour for missing keys.
  - RTL readiness checklist for future locale additions.
- Extended `apps/web/src/lib/i18n/formatting.ts` with:
  - `formatSettlementAmount(amountUsdc)` — canonical USDC display, never converts.
  - `formatDisplayConversion(...)` — informational display with rate timestamp
    and staleness attribution line.
  - `formatDateTimeWithZone(...)` — timezone-explicit datetime for check-in/out
    and escrow release timestamps.

#### Launch readiness record
- Created `LAUNCH_READINESS.md` — a release gate template covering 10 blocking
  areas: Functional, Security, Contract, Payment, Accessibility, Performance,
  Privacy, Monitoring, Backup, and Support.
- Every area requires: named owner, sign-off date, and links to evidence.
- Open risks require: owner, impact, mitigation, and expiry date.
- Release manager sign-off block confirms commit/tag and environment tested.
- Completed copies are archived in `docs/releases/`.

#### Analytics event taxonomy and privacy framework
- Created `docs/ANALYTICS_TAXONOMY.md` defining:
  - Event taxonomy for search, listing, booking, payment, and cancellation funnels.
  - Consent model: pseudonymous sessions (implied ToS); no behavioural profiling
    without explicit opt-in; opt-out persisted in `user_analytics_preferences`.
  - Retention policy: funnel events 24 months, search 12 months, views 6 months.
  - Access controls: raw `user_id` columns never exposed to BI/external dashboards.
  - Deduplication rule for booking/payment events (60-second window).
  - Funnel dashboard SQL queries for search-to-booking and payment completion rates.
  - Forbidden property keys list (wallet secrets, amounts, message content, PII).
- Added migration `00021_create_funnel_events.sql`:
  - `funnel_events` table with `event`, `session_id`, `user_id` (nullable),
    `properties (JSONB)`, and `created_at`.
  - `user_analytics_preferences` table for opt-out state.
  - Indexes for event-type + time, session, user, and booking_id queries.
  - Deduplication trigger on `(event, booking_id)` within 60 seconds.
  - `purge_stale_funnel_events()` and `purge_stale_search_analytics()` functions.
  - `analytics_funnel_daily` aggregate view (no user_id).
- Added `apps/backend/src/services/analytics.service.ts` with:
  - `emitFunnelEvent()` — fire-and-forget; swallows all errors so analytics
    never blocks request handlers.
  - Property validation that blocks forbidden keys before insert.
  - `isAnalyticsOptedOut()` / `setAnalyticsOptOut()` for opt-out management.
  - Typed convenience emitters for every event in the taxonomy.
  - `getFunnelSummary(days)` aggregate query for dashboard use.

### Decisions

- **Settlement currency**: USDC is the only settlement currency. This will not change
  without a contract migration and explicit user communication.
- **Display currencies**: 20 currencies supported via `open.er-api.com`.  Rates are
  informational only; stale rates show a UI warning, never fabricated precision.
- **Analytics opt-out**: Opt-out must be implemented before mainnet launch (tracked
  in ROADMAP.md Q4 2026 milestone).
- **Stale TODO items removed**: The PropertyMapPin 300-line accessibility checklist
  and the 450-item generic web-app checklist in TODO.md were not Rentars-specific
  work items.  They have been removed.  Real accessibility work is tracked in
  ROADMAP.md and LAUNCH_READINESS.md Section 5.
- **Dispute resolution**: Backend complete.  Frontend (DisputeButton + DisputeModal)
  remains a sprint blocker for Q4 launch.

---

## [0.1.0] - 2024-01-01

### Added
- Initial release of Rentars platform
- Backend API with Express/TypeScript
- Frontend web application with Next.js
- Stellar Soroban smart contract integration
- TrustlessWork escrow integration
- Supabase for data persistence
- Docker development environment
- User authentication with passkeys
- Property listing and booking functionality
- Wallet connection via Stellar