# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security — 2026-10-19

#### #740 — Recovery and verification token hardening
- Email verification and password reset tokens are claimed with conditional updates, so a concurrent reuse of the same link fails.
- Password reset looks accounts up by email in the `users` table. The previous `listUsers()` call only saw the first page.
- Password reset responses take a constant minimum time and send email without awaiting delivery, so known and unknown addresses look the same.
- A successful reset or logout-all-devices revokes access tokens issued before that moment. The new `sessionRevocationGuard` enforces this and fails closed.
- Removed the hard-coded `'secret'` fallback for `JWT_SECRET` in the auth middleware.

#### #741 — Abuse controls for authentication endpoints
- Each auth route has its own IP bucket, plus an account bucket for login, register, reset request and wallet endpoints.
- Added `TRUST_PROXY` (hop count or trusted address list; `true` is rejected) so rate limits key on the real client behind a load balancer.
- Redis failure on auth routes returns 503 instead of silently disabling limits.
- Operator overrides: `AUTH_IP_RATE_POINTS`, `AUTH_IP_RATE_WINDOW_SECONDS`, `AUTH_ACCOUNT_RATE_POINTS`, `AUTH_ACCOUNT_RATE_WINDOW_SECONDS`.

#### #742 — Audit coverage for account and recovery events
- Added audit records for password reset requests, email verification and wallet linking.
- Refund approvals are recorded under `admin.refund_approve` (previously logged as `payment.confirmed`).
- Audit metadata redaction now covers arrays and raw payload or body keys.
- Migration `00065_audit_logs_append_only.sql` blocks `UPDATE` and `DELETE` on `audit_logs`.

#### #743 — Cookie, CORS and CSRF review
- Disallowed origins no longer raise a 500. CORS headers are withheld and the browser blocks the read.
- In production, `CORS_ORIGIN` must be explicit and use `https://`.
- Documented token transport, CORS, and CSRF behaviour in `docs/SECURITY_AUTH_HARDENING.md`.
- Repaired broken imports that stopped `auth.routes.ts` from loading: the auth routes now use `authenticate`, the wallet simulate and transaction preflight use `soroban.ts`, and a stray `await` in `probe.service.ts` is removed.
- Bearer-authenticated mutations skip the double-submit CSRF check. The web client sends Bearer tokens and never sends `X-CSRF-Token`, so every write was being rejected. Cookie-only cross-site posts still get 403.

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