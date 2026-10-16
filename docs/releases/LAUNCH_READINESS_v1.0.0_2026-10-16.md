# Launch Readiness Record — v1.0.0

> **Archived example.** This file shows the expected level of evidence for each
> blocking criterion.  Real completions must link to actual CI runs, audit reports,
> and monitoring dashboards.

---

## Release metadata

| Field | Value |
|---|---|
| Release version | `v1.0.0` |
| Release candidate tag / commit | `v1.0.0-rc1` @ `abc1234def5678` |
| Release manifest path | `docs/releases/manifest-1.0.0.json` |
| Target environment | mainnet |
| Planned release date | 2026-10-30 |
| Release manager | @release-manager |
| Sign-off deadline | 2026-10-28 |

### Release manifest attachment

- [x] `bun run release:manifest` run for commit `abc1234def5678`; output committed to
  `docs/releases/manifest-1.0.0.json`.
- [x] Manifest `release.commit` = `abc1234def5678` ✅
- [x] Manifest `database.latest_migration` = `00030_add_support_cases.sql` matches staging DB ✅

---

## Section 1 — Functional completeness

**Owner:** @functional-lead  **Sign-off date:** 2026-10-27

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| F1 | 🔴 | All P0/P1 bugs resolved | ✅ | https://github.com/Rentars/Rentars/milestone/1 |
| F2 | 🔴 | Booking lifecycle tested end-to-end | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F3 | 🔴 | Property creation, image upload, and search | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F4 | 🔴 | Cancellation and refund flow | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F5 | 🔴 | Dispute raise/resolve flow | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F6 | 🔴 | Notifications delivered for all booking events | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F7 | 🟡 | Host dashboard earnings and occupancy data | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F8 | 🔴 | Wallet authentication (Freighter) on mainnet | ✅ | Manual testnet walkthrough recorded: link-to-loom |
| F9 | 🔴 | Email verification and password reset | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F10 | 🔴 | All i18n locales render without missing-key errors | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F11 | 🔴 | Support case creation and lookup works end-to-end | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |
| F12 | 🟡 | Currency staleness warning when rate is outdated | ✅ | https://github.com/Rentars/Rentars/actions/runs/12345 |

### Open functional risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| PostGIS extension not yet applied on mainnet DB | @db-admin | Geolocation search degrades to text-only | Geolocation filter hidden in UI until migration confirmed | 2026-11-15 |

---

## Section 2 — Security

**Owner:** @security-lead  **Sign-off date:** 2026-10-27

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| S1 | 🔴 | No secrets in Git | ✅ | gitleaks scan: https://github.com/Rentars/Rentars/actions/runs/22222 |
| S2 | 🔴 | Prod env vars in secrets manager | ✅ | Verified in AWS Secrets Manager — screenshot on internal wiki |
| S3 | 🔴 | JWT secrets ≥ 32 bytes entropy | ✅ | Confirmed via `openssl rand -hex 32` output |
| S4 | 🔴 | CORS restricted to production domains | ✅ | Config reviewed in `apps/backend/src/config/env.ts` |
| S5 | 🔴 | Rate limiting active | ✅ | Load test results: link-to-report |
| S6 | 🔴 | Supabase RLS policies reviewed | ✅ | RLS review PR #800 |
| S7 | 🔴 | hCaptcha active on auth endpoints | ✅ | Tested manually on staging |
| S8 | 🔴 | Input validation in all controllers | ✅ | Code review PR #780 |
| S9 | 🟡 | File upload restrictions verified | ✅ | PR #765 |
| S10 | 🔴 | HTTPS enforced | ✅ | Verified via `curl -I http://api.rentars.app` → 301 |
| S11 | 🔴 | Dependency audit — no critical CVEs | ✅ | `bun audit` output: link-to-report |
| S12 | 🔴 | Admin routes protected by RBAC | ✅ | PR #790 |
| S13 | 🔴 | Support case routes scoped access enforced | ✅ | PR #847-impl |
| S14 | 🟡 | Security exceptions reviewed | ✅ | docs/security-exceptions.md reviewed 2026-10-20 |

### Open security risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 3 — Contract / blockchain

**Owner:** @blockchain-lead  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| C1 | 🔴 | Third-party Soroban audit completed | ☐ | Audit scheduled — OtterSec Q4 2026 |
| C2 | 🔴 | All audit findings resolved | ☐ | Pending audit completion |
| C3 | 🔴 | Contract IDs recorded in secure location | ✅ | Stored in AWS Secrets Manager |
| C4 | 🔴 | Mainnet contracts deployed from audited admin account | ✅ | Deployment log: link |
| C5 | 🔴 | Admin keys stored offline | ✅ | Hardware wallet — key ceremony recorded |
| C6 | 🔴 | Cross-contract calls verified on mainnet | ✅ | Manual testnet verification: link |
| C7 | 🔴 | TrustlessWork escrow tested on mainnet with real USDC | ✅ | Test transaction: link-to-stellar-explorer |
| C8 | 🟡 | Upgrade/migration path documented | ✅ | `ARCHITECTURE.md` §Contracts |
| C9 | 🔴 | ABI hashes in manifest match deployed ABIs | ✅ | `docs/releases/manifest-1.0.0.json` |

### Open contract risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| Third-party audit not complete at launch | @blockchain-lead | Undetected critical contract vulnerability | Deploy to testnet only until audit completes | 2026-11-30 |

---

## Section 4 — Payment and escrow

**Owner:** @payments-lead  **Sign-off date:** 2026-10-27

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| P1 | 🔴 | End-to-end USDC escrow flow verified | ✅ | E2E test run: link |
| P2 | 🔴 | Refund policy env vars documented and validated | ✅ | `apps/backend/.env.production.example` |
| P3 | 🔴 | Settlement amounts stored as USDC only | ✅ | DB schema review — `total_price DECIMAL(12,2)` |
| P4 | 🔴 | Staleness warning shown when `stale: true` | ✅ | Storybook screenshot + unit test |
| P5 | 🔴 | Receipt PDFs show USDC + display amount + timestamp | ✅ | Receipt PDF unit test in `receipt.service.test.ts` |
| P6 | 🔴 | Idempotency service prevents duplicates | ✅ | Idempotency unit tests |
| P7 | 🔴 | Cancellation and partial-refund calculations tested | ✅ | `refundPolicy.service.test.ts` |
| P8 | 🟡 | `display_currency` and `display_amount` columns populated | ✅ | Migration `00029_add_display_currency_to_bookings.sql` |

### Open payment risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 5 — Accessibility

**Owner:** @a11y-lead  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| A1 | 🔴 | WCAG 2.1 AA automated scan passes on key pages | ☐ | Axe scan scheduled pre-launch |
| A2 | 🔴 | Keyboard navigation tested end-to-end | ☐ | |
| A3 | 🟡 | Screen reader tested | ☐ | |
| A4 | 🔴 | Map markers have accessible names | ✅ | PR #755 |
| A5 | 🔴 | Focus indicators visible in light and dark modes | ✅ | PR #756 |
| A6 | 🔴 | All images have alt text | ✅ | Automated lint rule in CI |
| A7 | 🔴 | Color contrast meets WCAG AA | ✅ | Contrast audit in Figma |
| A8 | 🔴 | Wallet modal accessible via keyboard | ✅ | Manual test on staging |

### Open accessibility risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| Full automated WCAG scan not yet run | @a11y-lead | Undiscovered AA failures | Run axe-core scan before launch; fix all critical/serious | 2026-10-29 |

---

## Section 6 — Performance

**Owner:** @platform-lead  **Sign-off date:** 2026-10-26

| # | Pri | Criterion | Status | Target | Evidence link |
|---|---|---|---|---|---|
| Pf1 | 🔴 | Lighthouse score (search, mobile) | ✅ | ≥ 75 | Score: 82 — link |
| Pf2 | 🔴 | Search API P95 under load | ✅ | < 500 ms | k6 report: P95 = 340 ms |
| Pf3 | 🔴 | Booking API P95 | ✅ | < 1 s | k6 report: P95 = 620 ms |
| Pf4 | 🔴 | Redis cache active, hit rate > 70% | ✅ | | Redis dashboard screenshot |
| Pf5 | 🟡 | DB query plans reviewed | ✅ | | EXPLAIN ANALYZE output: link |
| Pf6 | 🟡 | Image upload with max file size | ✅ | | Manual test: 10 MB JPEG ✓ |
| Pf7 | 🔴 | Rate limiter returns 429 cleanly | ✅ | | Integration test: link |
| Pf8 | 🟡 | 504 on slow upstream | ✅ | | Manual chaos test: link |

### Open performance risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 7 — Privacy and analytics

**Owner:** @privacy-lead  **Sign-off date:** 2026-10-25

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| Pr1 | 🔴 | No wallet keys / message content / raw PII in analytics | ✅ | Analytics taxonomy review PR #820 |
| Pr2 | 🔴 | Pseudonymous identifiers in analytics | ✅ | `ANALYTICS_TAXONOMY.md` §PII |
| Pr3 | 🔴 | Analytics opt-out implemented | ✅ | Cookie consent component — PR #815 |
| Pr4 | 🟡 | Data retention policy enforced | ✅ | Purge job scheduled — cron verified |
| Pr5 | 🔴 | Privacy notice updated | ✅ | Legal review 2026-10-10 |
| Pr6 | 🟡 | GDPR DSR process documented | ✅ | `docs/SECURITY_DATA_LIFECYCLE.md` |
| Pr7 | 🔴 | Search analytics events schema-validated | ✅ | Validation in `searchAnalytics.service.ts` |
| Pr8 | 🔴 | No undocumented cross-border data transfers | ✅ | Data inventory reviewed: `docs/data-inventory.md` |

### Open privacy risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 8 — Monitoring and alerting

**Owner:** @infra-lead  **Sign-off date:** 2026-10-26

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| M1 | 🔴 | `/health` checked by uptime monitor < 1 min | ✅ | BetterStack monitor: link |
| M2 | 🔴 | Alert fires within 5 min of unhealthy | ✅ | Alert test firing recorded |
| M3 | 🔴 | Error rate alert > 1% 5xx | ✅ | Datadog alert: link |
| M4 | 🔴 | On-call rotation defined | ✅ | PagerDuty schedule: link |
| M5 | 🔴 | Structured logs to centralised provider | ✅ | Datadog log pipeline: link |
| M6 | 🔴 | Stellar transaction failure monitored | ✅ | Alert configured in Datadog |
| M7 | 🔴 | Redis memory + eviction alerts | ✅ | Redis Cloud alerts: link |
| M8 | 🟡 | Supabase slow-query alerts | ✅ | Supabase dashboard alert |
| M9 | 🔴 | Exchange-rate staleness logged + alerted | ✅ | `warn` log confirmed; Datadog alert set |
| M10 | 🟡 | `/metrics` scraped by Prometheus | ✅ | Prometheus target: link |
| M11 | 🔴 | Runbooks verified and links up-to-date | ✅ | `apps/backend/RUNBOOKS.md` reviewed |

### Open monitoring risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 9 — Backup and recovery

**Owner:** @infra-lead  **Sign-off date:** 2026-10-26

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| B1 | 🔴 | Supabase PITR backups enabled | ✅ | Supabase dashboard screenshot |
| B2 | 🔴 | Restore drill completed in staging | ✅ | Drill report: `scripts/backup-restore-drill.sh` output |
| B3 | 🟡 | Redis recovery procedure documented | ✅ | `docs/backup-restore-verification.md` |
| B4 | 🔴 | Frontend rollback tested (Vercel) | ✅ | Vercel deployment promotion tested |
| B5 | 🔴 | Backend rollback tested (Docker) | ✅ | Docker redeploy runbook verified |
| B6 | 🔴 | RTO and RPO documented | ✅ | `docs/CAPACITY_PLANNING.md` §Recovery |

### Open backup/recovery risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 10 — Support readiness

**Owner:** @support-lead  **Sign-off date:** 2026-10-27

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| Su1 | 🔴 | User-facing error messages are actionable | ✅ | Error message review PR #830 |
| Su2 | 🔴 | Support team briefed on known issues | ✅ | Support briefing doc: internal wiki link |
| Su3 | 🔴 | Issue reporting channel operational | ✅ | GitHub Issues + triage workflow configured |
| Su4 | 🔴 | README, DEPLOYMENT.md, RUNBOOKS.md up to date | ✅ | Reviewed and updated 2026-10-20 |
| Su5 | 🔴 | 48-hour post-launch monitoring checklist defined | ✅ | See Appendix B below |
| Su6 | 🔴 | Support case system operational | ✅ | `POST /api/v1/support/cases` tested in staging |
| Su7 | 🟡 | Browser/wallet compatibility matrix published | ✅ | `docs/BROWSER_WALLET_COMPATIBILITY.md` |

---

## Release manager sign-off

| Field | Value |
|---|---|
| Release manager | @release-manager |
| Commit / tag | `v1.0.0-rc1` @ `abc1234def5678` |
| Environment | mainnet |
| Sign-off date | *(pending C1/C2 audit + A1/A2 accessibility)* |
| Notes | Two blocking items remain open with accepted risks: C1 (contract audit — testnet-only until resolved) and A1/A2 (accessibility scan scheduled for 2026-10-29). |

---

## Appendix A — Known unresolved risks at release

| Risk | GitHub issue | Owner | Due date | Impact if not resolved |
|---|---|---|---|---|
| Third-party Soroban contract audit incomplete | #900 | @blockchain-lead | 2026-11-30 | Critical contract vulnerability could go undetected; mitigated by testnet-only mainnet deployment |
| WCAG full automated scan not completed | #901 | @a11y-lead | 2026-10-29 | AA accessibility failures may exist on key pages |
| PostGIS not yet applied on mainnet DB | #902 | @db-admin | 2026-11-15 | Geolocation search degraded to text-only |

---

## Appendix B — 48-hour post-launch monitoring checklist

| Time | Check | Owner |
|---|---|---|
| T+0 | Confirm `/health` returns 200 | @infra-lead |
| T+0 | Confirm first real booking completes escrow lock | @payments-lead |
| T+1h | Review error rate dashboard; confirm < 0.1% 5xx | @infra-lead |
| T+4h | Review Stellar transaction failure rate | @blockchain-lead |
| T+6h | Confirm exchange-rate refresh loop running (no stale warnings) | @platform-lead |
| T+12h | Review Redis memory usage and eviction rate | @infra-lead |
| T+24h | Review search P95 under real traffic | @platform-lead |
| T+48h | Compile post-launch incident summary | @release-manager |

---

*Template version: 2.0 — 2026-10-16*
*Closes: #842*
