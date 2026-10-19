# Launch Readiness Record

This document is the **single gate** for production releases.
A release cannot be labelled production-ready until every blocking area below
has an approved sign-off with a link to supporting evidence.

Fill in this template for each release candidate.  Archive completed copies in
`docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md`.

> **Blocking criteria summary:** A section is considered blocked if any
> criterion marked 🔴 (blocking) has Status = ☐ (incomplete) without an
> accepted open-risk entry.  The release manager must not approve until all
> 🔴 rows are either ✅ (complete) or have an open-risk row with a named owner
> and expiry date.

---

## Release metadata

| Field | Value |
|---|---|
| Release version | *e.g. v1.0.0* |
| Release candidate tag / commit | *e.g. `v1.0.0-rc1` @ `abc1234`* |
| Release manifest path | *`docs/releases/manifest-<version>.json`* |
| Target environment | *testnet / mainnet* |
| Planned release date | |
| Release manager | *@github-handle* |
| Sign-off deadline | |

### Release manifest attachment

Before approving the release, the release manager must confirm:

- [ ] `bun run release:manifest` has been run for this commit and the output file
  committed to `docs/releases/manifest-<version>.json`.
- [ ] The manifest `release.commit` field matches the commit being released.
- [ ] The manifest `database.latest_migration` field is consistent with what is
  applied in the target environment.

---

## How to use this document

1. Copy this template to `docs/releases/LAUNCH_READINESS_<version>_<YYYY-MM-DD>.md`.
2. Assign an owner (GitHub handle) to each section.
3. Each owner must:
   a. Complete their section.
   b. Link to evidence (test reports, audit results, monitoring dashboards, CI run URLs).
   c. Add their GitHub handle + date under **Sign-off**.
4. Open risks must have: owner, impact assessment, mitigation, and expiry date.
5. The release manager reviews all sections and confirms the release is unblocked.
6. This completed document is committed alongside the release tag.
7. This document plus the `manifest-<version>.json` are attached to the GitHub
   release notes.

**Legend:**
- 🔴 = Blocking criterion — release is blocked until this is satisfied or risk-accepted.
- 🟡 = Advisory criterion — noted but does not block release on its own.
- ✅ = Complete.  ☐ = Incomplete / not yet checked.

**Blocking areas**: Functional, Security, Contract, Payment, Accessibility,
Performance, Privacy, Monitoring, Backup, Support.

---

## Section 1 — Functional completeness

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| F1 | 🔴 | All P0/P1 bugs are resolved or have an accepted workaround documented | ☐ | |
| F2 | 🔴 | Booking lifecycle (create → confirm → release escrow) tested end-to-end | ☐ | |
| F3 | 🔴 | Property creation, image upload, and search return correct results | ☐ | |
| F4 | 🔴 | Cancellation and refund flow matches the configured refund policy | ☐ | |
| F5 | 🔴 | Dispute raise/resolve flow works (backend + frontend — issue #112) | ☐ | |
| F6 | 🔴 | Notifications (email + push) delivered for all booking lifecycle events | ☐ | |
| F7 | 🟡 | Host dashboard earnings and occupancy data are accurate | ☐ | |
| F8 | 🔴 | Wallet authentication (Freighter) works on target network | ☐ | |
| F9 | 🔴 | Email verification and password reset flows complete successfully | ☐ | |
| F10 | 🔴 | All i18n locales (en, es, fr, pt) render without missing-key errors | ☐ | |
| F11 | 🔴 | Support case creation and lookup works end-to-end (issue #847) | ☐ | |
| F12 | 🟡 | Currency display conversion shows staleness warning when rate is outdated | ☐ | |

### Open functional risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 2 — Security

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| S1 | 🔴 | No secrets committed to Git (`git log --all -p \| grep -E 'SECRET\|KEY\|TOKEN'`) | ☐ | |
| S2 | 🔴 | All production environment variables set in secrets manager, not in repo | ☐ | |
| S3 | 🔴 | JWT secrets meet minimum entropy (≥ 32 random bytes) | ☐ | |
| S4 | 🔴 | CORS origin list is restricted to known production domains | ☐ | |
| S5 | 🔴 | Rate limiting active and tuned for production traffic | ☐ | |
| S6 | 🔴 | All Supabase RLS policies reviewed against latest schema | ☐ | |
| S7 | 🔴 | hCaptcha active on auth endpoints | ☐ | |
| S8 | 🔴 | Input validation and parameterised queries confirmed in all controllers | ☐ | |
| S9 | 🟡 | File upload restrictions (type, size, EXIF stripping) verified | ☐ | |
| S10 | 🔴 | HTTPS enforced; HTTP redirects to HTTPS | ☐ | |
| S11 | 🔴 | Dependency audit run (`bun audit` / `yarn audit`); no unresolved critical CVEs | ☐ | |
| S12 | 🔴 | Admin routes protected by RBAC middleware | ☐ | |
| S13 | 🔴 | Support case routes enforce scoped access; internal notes excluded from customer responses | ☐ | |
| S14 | 🟡 | Security exceptions register reviewed and all accepted risks re-confirmed | ☐ | |

### Open security risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 3 — Contract / blockchain

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| C1 | 🔴 | Third-party Soroban contract audit completed (Property, Booking, Review) | ☐ | |
| C2 | 🔴 | All audit findings resolved or risk-accepted with named owner | ☐ | |
| C3 | 🔴 | Contract IDs recorded in a secure, versioned location | ☐ | |
| C4 | 🔴 | Mainnet contracts deployed from a dedicated, audited admin account | ☐ | |
| C5 | 🔴 | Admin keys stored offline; access restricted to named individuals | ☐ | |
| C6 | 🔴 | Cross-contract calls and initialisation verified on mainnet | ☐ | |
| C7 | 🔴 | TrustlessWork escrow integration tested on mainnet with real USDC | ☐ | |
| C8 | 🟡 | Contract upgrade/migration path documented (no upgrade path = immutability acknowledged) | ☐ | |
| C9 | 🔴 | ABI SHA-256 hashes in release manifest match deployed contract ABIs | ☐ | |

### Open contract risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 4 — Payment and escrow

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| P1 | 🔴 | End-to-end USDC escrow flow (lock → release + cancel → refund) verified on mainnet | ☐ | |
| P2 | 🔴 | Refund policy configuration (`REFUND_*` env vars) documented and validated | ☐ | |
| P3 | 🔴 | Settlement amounts stored as USDC only; no fiat amounts in `bookings.total_price` | ☐ | |
| P4 | 🔴 | Exchange rate staleness warning shown to users when `stale: true` | ☐ | |
| P5 | 🔴 | Receipt PDFs show USDC amount, display amount (with timestamp), and currency note | ☐ | |
| P6 | 🔴 | Idempotency service prevents duplicate booking/payment submissions | ☐ | |
| P7 | 🔴 | Cancellation and partial-refund calculations tested against policy config | ☐ | |
| P8 | 🟡 | `display_currency` and `display_amount` columns populated on new bookings | ☐ | |

### Open payment risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 5 — Accessibility

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| A1 | 🔴 | WCAG 2.1 AA automated scan passes on key pages (search, property detail, booking, confirmation) | ☐ | |
| A2 | 🔴 | Keyboard navigation tested end-to-end for booking flow | ☐ | |
| A3 | 🟡 | Screen reader (VoiceOver / NVDA) tested on booking and search flows | ☐ | |
| A4 | 🔴 | All interactive map markers have accessible names (see PropertyMapPin) | ☐ | |
| A5 | 🔴 | Focus indicators visible in both light and dark modes | ☐ | |
| A6 | 🔴 | All images have meaningful alt text | ☐ | |
| A7 | 🔴 | Color contrast meets WCAG AA in both light and dark modes | ☐ | |
| A8 | 🔴 | Wallet connection modal accessible via keyboard | ☐ | |

> Note: full WCAG validation requires manual testing with assistive technologies
> and expert accessibility review.  Automated tools alone are not sufficient.

### Open accessibility risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 6 — Performance

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Target | Evidence link |
|---|---|---|---|---|---|
| Pf1 | 🔴 | Lighthouse Performance score (search page, mobile) | ☐ | ≥ 75 | |
| Pf2 | 🔴 | Search API P95 response time under realistic load | ☐ | < 500 ms | |
| Pf3 | 🔴 | Booking creation API P95 response time | ☐ | < 1 s | |
| Pf4 | 🔴 | Redis cache confirmed active (cache hit rate > 70% under load) | ☐ | | |
| Pf5 | 🟡 | Database query plan reviewed for search and booking queries (no sequential scans on large tables) | ☐ | | |
| Pf6 | 🟡 | Property image upload tested with max allowed file size | ☐ | | |
| Pf7 | 🔴 | Rate limiter tested: requests beyond threshold return 429 cleanly | ☐ | | |
| Pf8 | 🟡 | Request timeout (504) tested with simulated slow upstream dependencies | ☐ | | |

### Open performance risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 7 — Privacy and analytics

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| Pr1 | 🔴 | Analytics events do not contain wallet private keys, message content, or raw PII | ☐ | |
| Pr2 | 🔴 | Pseudonymous user identifiers used in analytics where user identity is not required | ☐ | |
| Pr3 | 🔴 | Analytics opt-out mechanism implemented and tested | ☐ | |
| Pr4 | 🟡 | Analytics data retention policy enforced (automated purge job configured) | ☐ | |
| Pr5 | 🔴 | Privacy notice updated to reflect analytics collection | ☐ | |
| Pr6 | 🟡 | GDPR/data-subject-request process documented and tested | ☐ | |
| Pr7 | 🔴 | Search analytics events are schema-validated before insert | ☐ | |
| Pr8 | 🔴 | No cross-border user data transfers outside documented regions without legal basis | ☐ | |

### Open privacy risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 8 — Monitoring and alerting

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| M1 | 🔴 | `/health` endpoint returns 200 and checked by uptime monitor (< 1 min interval) | ☐ | |
| M2 | 🔴 | Alert fires within 5 minutes of service going unhealthy | ☐ | |
| M3 | 🔴 | Error rate alert configured: > 1% 5xx rate triggers page | ☐ | |
| M4 | 🔴 | On-call rotation defined; all escalation contacts reachable | ☐ | |
| M5 | 🔴 | Structured logs flowing to centralised log provider | ☐ | |
| M6 | 🔴 | Stellar transaction failure rate monitored | ☐ | |
| M7 | 🔴 | Redis memory and eviction alerts configured | ☐ | |
| M8 | 🟡 | Supabase slow-query alerts configured | ☐ | |
| M9 | 🔴 | Exchange-rate staleness logged at `warn` level and alert set on repeated staleness | ☐ | |
| M10 | 🟡 | `/metrics` endpoint scraped (Prometheus-compatible) | ☐ | |
| M11 | 🔴 | Runbooks verified and links up-to-date (see apps/backend/RUNBOOKS.md) | ☐ | |

### Open monitoring risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

> **SLO reference.** Measurable objectives, alert thresholds, burn-rate rules, and error-budget policy for all critical journeys are defined in [`docs/SLO.md`](./SLO.md).

---

## Section 9 — Backup and recovery

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| B1 | 🔴 | Supabase automated backups enabled (point-in-time recovery) | ☐ | |
| B2 | 🔴 | Restore drill completed successfully in staging environment | ☐ | |
| B3 | 🟡 | Redis data recovery procedure documented (Redis is cache-only; loss is tolerable) | ☐ | |
| B4 | 🔴 | Frontend rollback procedure tested (Vercel: promote previous deployment) | ☐ | |
| B5 | 🔴 | Backend rollback procedure tested (Docker image tagging + redeployment) | ☐ | |
| B6 | 🔴 | RTO (recovery time objective) and RPO (recovery point objective) documented | ☐ | |

### Open backup/recovery risks

| Risk | Owner | Impact | Mitigation | Expiry |
|---|---|---|---|---|
| | | | | |

---

## Section 10 — Support readiness

**Owner:** _______________  **Sign-off date:** _______________

| # | Pri | Criterion | Status | Evidence link |
|---|---|---|---|---|
| Su1 | 🔴 | User-facing error messages are actionable (not raw stack traces) | ☐ | |
| Su2 | 🔴 | Support team briefed on known issues and workarounds | ☐ | |
| Su3 | 🔴 | Issue reporting channel (GitHub Issues or equivalent) operational | ☐ | |
| Su4 | 🔴 | Documentation (README, DEPLOYMENT.md, RUNBOOKS.md) up to date | ☐ | |
| Su5 | 🔴 | Post-launch monitoring checklist defined for the first 48 hours | ☐ | |
| Su6 | 🔴 | Support case system operational; authorized staff can create and look up cases | ☐ | |
| Su7 | 🟡 | Browser/wallet compatibility matrix published and linked from README | ☐ | |

---

## Release manager sign-off

I confirm that:
- All 🔴 blocking criteria above have approved evidence or an accepted open-risk entry.
- All open risks have named owners, written mitigations, and expiry dates.
- The release manifest (`docs/releases/manifest-<version>.json`) matches this commit.
- This document is committed to the repository alongside the release tag.

| Field | Value |
|---|---|
| Release manager | |
| Commit / tag | |
| Environment | |
| Sign-off date | |
| Notes | |

---

## Appendix — Known unresolved risks at release

<!-- Carry forward any risk that was accepted rather than resolved.
     Each must be tracked as a GitHub issue with a due date. -->

| Risk | GitHub issue | Owner | Due date | Impact if not resolved |
|---|---|---|---|---|
| | | | | |

---

*Template version: 2.0 — 2026-10-16*
*Closes: #842*
*Archive completed copies in: `docs/releases/`*
