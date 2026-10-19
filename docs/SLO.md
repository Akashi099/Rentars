# Service-Level Objectives (SLO)

This document defines the Service-Level Indicators (SLIs), Service-Level
Objectives (SLOs), error budgets, alert thresholds, and burn-rate rules for
every critical user journey on the Rentars platform.

It is the authoritative reference for:
- deciding whether to hold or release a build (§9 error-budget policy)
- tuning alerting rules in the observability platform
- assigning on-call ownership and runbook links

**Review cadence.** Targets in this document are reviewed at each milestone:
after load-test certification (§10.1), after testnet go-live (§10.2), and on a
fixed quarterly calendar (§10.3). All changes require the owner's sign-off and
a PR against this file.

---

## Table of contents

1. [Terminology and conventions](#1-terminology-and-conventions)
2. [Journey J1 — Availability (platform uptime)](#2-journey-j1--availability-platform-uptime)
3. [Journey J2 — Property search](#3-journey-j2--property-search)
4. [Journey J3 — Booking creation](#4-journey-j3--booking-creation)
5. [Journey J4 — Payment reconciliation (escrow)](#5-journey-j4--payment-reconciliation-escrow)
6. [Journey J5 — Notification delivery](#6-journey-j5--notification-delivery)
7. [Journey J6 — Blockchain sync lag](#7-journey-j6--blockchain-sync-lag)
8. [Error budget policy](#8-error-budget-policy)
9. [Alert implementation guide](#9-alert-implementation-guide)
10. [Baseline establishment and review cadence](#10-baseline-establishment-and-review-cadence)
11. [Owner registry](#11-owner-registry)

---

## 1. Terminology and conventions

| Term | Definition |
|---|---|
| **SLI** | Service-Level Indicator — the measured quantity (a ratio, a latency, a count). |
| **SLO** | Service-Level Objective — the target percentage or threshold for the SLI over a rolling window. |
| **Error budget** | `100% − SLO%` of the window. Consumption at or below this rate is acceptable; above it triggers a release hold. |
| **Burn rate** | How quickly the error budget is being consumed relative to the allowed rate. A burn rate of 1× means the budget is consumed exactly on pace; 14× means the budget is exhausted in 1/14 of the window. |
| **Rolling window** | All SLOs use a **28-day rolling window** unless stated otherwise. This matches the Google SRE standard and is long enough to smooth weekly traffic patterns. |
| **Good request** | A request that satisfies both the availability criterion (status < 500) and, where applicable, the latency criterion (response within the target threshold). |
| **Bad request** | Any request that returns HTTP 5xx, or — for latency SLOs — any request whose latency exceeds the target threshold. Conflict responses (409) and expected client errors (400, 404) are **excluded** from the bad count for booking and payment journeys. |

### Metric sources

All SLIs are derived from metrics exposed at `GET /metrics` (Prometheus text
format, protected by `METRICS_TOKEN`). The key metric families are:

| Metric | Type | Labels | Source file |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` | `src/middleware/metrics.middleware.ts` |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status` | `src/middleware/metrics.middleware.ts` |
| `http_errors_total` | counter | `method`, `route`, `status_class` | `src/middleware/metrics.middleware.ts` |
| `bookings_created_total` | counter | — | `src/middleware/metrics.middleware.ts` |
| `escrow_operations_total` | counter | `operation` | `src/middleware/metrics.middleware.ts` |
| `escrow_failures_total` | counter | `operation` | `src/middleware/metrics.middleware.ts` |
| `payment_failures_total` | counter | `reason` | `src/middleware/metrics.middleware.ts` |
| `blockchain_rpc_calls_total` | counter | `method`, `outcome` | `src/middleware/metrics.middleware.ts` |
| `blockchain_rpc_duration_seconds` | histogram | `method` | `src/middleware/metrics.middleware.ts` |
| `auth_events_total` | counter | `event`, `outcome` | `src/middleware/metrics.middleware.ts` |
| `probe_runs_total` | counter | `suite`, `outcome` | `src/middleware/metrics.middleware.ts` |
| `probe_duration_seconds` | histogram | `suite`, `target` | `src/middleware/metrics.middleware.ts` |
| Health check | HTTP endpoint | — | `src/routes/health.routes.ts` → `GET /health` |
| Sync staleness | DB query | `entity_type`, `synced_at` | `sync_log` table, `src/services/sync.service.ts` |
| Notification delivery | DB query | `created_at` | `notifications` table, `src/services/notification.service.ts` |

---

## 2. Journey J1 — Availability (platform uptime)

**User story.** A visitor can load the property listing page and receive a
valid response. This is the most fundamental obligation: the API and database
must be reachable.

### 2.1 SLI definition

```
SLI_availability =
  successful_health_checks / total_health_checks

where successful = GET /health returns HTTP 200 within 10 s
```

**Metric source.** External uptime monitor scraping `GET /health` at a
30-second interval. Internally, `probe_runs_total{suite="api_health",outcome="success"}`
and `probe_runs_total{suite="api_health",outcome="failure"}` track the same
signal from the synthetic probe runner (`src/services/probe.service.ts`).

**Secondary SLI** (deep health):

```
SLI_deep_health =
  checks where database="ok" AND (redis="ok" OR redis="not_configured")
  out of all /health responses
```

### 2.2 SLO

| Window | Target | Error budget |
|---|---|---|
| 28-day rolling | **99.5 %** | 0.5 % ≈ **3 h 21 min** of downtime per 28-day window |

> **Rationale.** Pre-mainnet and early-mainnet: 99.5% is appropriate for a
> platform that does not yet have redundant infrastructure. Raise to 99.9% once
> multi-region or hot-standby is in place (Tier 2+ per `docs/CAPACITY_PLANNING.md §4`).

### 2.3 Alert thresholds and burn-rate rules

| Severity | Condition | Burn rate | Window | Action |
|---|---|---|---|---|
| **Page (P1)** | Availability drops below 99.5 % SLO for 2 consecutive checks | — | 1 min | Page on-call immediately |
| **Page (P1)** | Burn rate ≥ 14× over 1 h | Exhausts 100 % of monthly budget in ≈ 2 h | 1 h | Page on-call |
| **Page (P1)** | Burn rate ≥ 6× over 6 h | Exhausts 100 % of budget in ≈ 4.5 h | 6 h | Page on-call |
| **Ticket (P2)** | Burn rate ≥ 1× over 3 days | On pace to exhaust budget | 3 d | Create ticket; no page |

**Prometheus alert rule (example — adapt to your Alertmanager/Grafana):**

```yaml
# Fast burn: 14× over 1 h
- alert: AvailabilityFastBurn
  expr: |
    (1 - rate(probe_runs_total{suite="api_health",outcome="success"}[1h])
         / rate(probe_runs_total{suite="api_health"}[1h]))
    > (14 * (1 - 0.995))
  for: 2m
  labels:
    severity: critical
    journey: J1_availability
  annotations:
    summary: "J1 Availability: fast burn rate ≥ 14×"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#1-api-outage--service-down"

# Slow burn: 1× over 3 d
- alert: AvailabilitySlowBurn
  expr: |
    (1 - rate(probe_runs_total{suite="api_health",outcome="success"}[3d])
         / rate(probe_runs_total{suite="api_health"}[3d]))
    > (1 * (1 - 0.995))
  for: 1h
  labels:
    severity: warning
    journey: J1_availability
  annotations:
    summary: "J1 Availability: slow burn — budget pacing to exhaustion"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#1-api-outage--service-down"
```

### 2.4 Responder

**Primary:** On-Call SRE (PagerDuty rotation `rentars-platform`).
**Secondary escalation (15 min):** Backend On-Call.

### 2.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §1 — API Outage / Service Down](../apps/backend/RUNBOOKS.md#1-api-outage--service-down)
- [`apps/backend/RUNBOOKS.md` §6 — Database Connectivity Issues](../apps/backend/RUNBOOKS.md#6-database-connectivity-issues)
- `docs/RECOVERY_RUNBOOK.md §4.1` — Database outage recovery

---

## 3. Journey J2 — Property search

**User story.** A tenant searches for available properties by location or
filter and receives a result set within an acceptable time. Both result
correctness (no 5xx) and response speed are obligations.

### 3.1 SLI definition

**Availability SLI:**

```
SLI_search_availability =
  count(http_requests_total{route="/api/v1/properties/search/advanced", status!~"5.."})
  /
  count(http_requests_total{route="/api/v1/properties/search/advanced"})
```

Same computation applies to:
- `route="/api/v1/properties"` (paginated list)
- `route="/api/v1/properties/search/nearby"` (geolocation search)
- `route="/api/v1/properties/search/suggestions"` (autocomplete)

**Latency SLI:**

```
SLI_search_latency_p99 =
  histogram_quantile(0.99,
    rate(http_request_duration_seconds_bucket{
      route=~"/api/v1/properties.*",
      method="GET"
    }[5m])
  )
```

A request is a **good request** if: status < 500 AND latency ≤ 500 ms.

### 3.2 SLO

| SLI | Window | Target | Error budget |
|---|---|---|---|
| Search availability | 28-day | **99.5 %** | 0.5 % ≈ 3 h 21 min |
| Search p99 latency ≤ 500 ms | 28-day | **95 %** | 5 % of requests may exceed 500 ms |

> **Latency note.** The 95% latency SLO (not 99%) reflects that uncached cold
> queries against large catalogues legitimately take longer. The 500 ms budget
> is consistent with `docs/CAPACITY_PLANNING.md §2.1` (cold p99 < 200 ms for
> up to 50 k listings) but allows headroom for cache misses and geographic
> search. Tighten to 200 ms at 99% once Redis warm-path is confirmed.

### 3.3 Alert thresholds and burn-rate rules

| Severity | Condition | Window | Action |
|---|---|---|---|
| **Page (P1)** | Availability burn rate ≥ 14× | 1 h | Page on-call |
| **Page (P1)** | p99 latency > 2 s for 5 consecutive minutes | 5 min | Page on-call |
| **Ticket (P2)** | Availability burn rate ≥ 1× | 3 d | Create ticket |
| **Ticket (P2)** | p99 latency > 500 ms for 30 min | 30 min | Create ticket |
| **Info** | Cache hit rate < 50 % for 15 min | 15 min | Investigate; no page |

**Cache hit rate alert formula:**

```yaml
- alert: SearchCacheHitRateLow
  expr: |
    rate(probe_target_total{target="search_cached",outcome="success"}[15m])
    / rate(probe_target_total{target="search_cached"}[15m])
    < 0.50
  for: 15m
  labels:
    severity: info
    journey: J2_search
  annotations:
    summary: "J2 Search: Redis cache hit rate below 50%"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#8-high-latency--slow-requests"
```

### 3.4 Responder

**Primary:** Backend On-Call.
**Escalation (20 min):** Database Owner (DBA) for index / query plan issues.

### 3.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §8 — High Latency / Slow Requests](../apps/backend/RUNBOOKS.md#8-high-latency--slow-requests)
- [`docs/CAPACITY_PLANNING.md` §6 — Scaling triggers and monitoring](./CAPACITY_PLANNING.md#6-scaling-triggers-and-monitoring)

---

## 4. Journey J3 — Booking creation

**User story.** An authenticated tenant submits a booking for available
dates. The system reserves the dates atomically (no double-booking) and
creates an escrow, all within an acceptable time. A 409 (date conflict) is
an expected business response and is **not** counted as an error.

### 4.1 SLI definition

**Availability SLI:**

```
SLI_booking_availability =
  count(http_requests_total{
    route="/api/v1/bookings",
    method="POST",
    status!~"5.."
  })
  /
  count(http_requests_total{
    route="/api/v1/bookings",
    method="POST",
    status!~"(409|429)"    -- conflicts and rate-limits excluded
  })
```

> Note: 409 (conflict) and 429 (rate-limit) are excluded from both numerator
> and denominator — they are correct behaviour, not service failures.

**Latency SLI:**

```
SLI_booking_latency_p99 =
  histogram_quantile(0.99,
    rate(http_request_duration_seconds_bucket{
      route="/api/v1/bookings",
      method="POST"
    }[5m])
  )
```

A request is **good** if: status ∉ {5xx} AND latency ≤ 3 000 ms.

**Exclusivity SLI** (derived from DB, not HTTP):

```
SLI_booking_exclusivity =
  (bookings with unique property_id+date ranges) / (total Confirmed/Pending bookings)
  = must be 1.0 at all times
```

Source: `SELECT COUNT(*) FROM bookings WHERE status IN ('Pending','Confirmed')`
cross-checked against the `create_booking_atomic_v2` serialisation invariant.

**Escrow success SLI:**

```
SLI_escrow_success =
  1 - (rate(escrow_failures_total{operation="create"}[5m])
       / rate(escrow_operations_total{operation="create"}[5m]))
```

### 4.2 SLO

| SLI | Window | Target | Error budget |
|---|---|---|---|
| Booking availability | 28-day | **99.0 %** | 1 % ≈ 6 h 43 min |
| Booking p99 latency ≤ 3 000 ms | 28-day | **95 %** | 5 % may exceed 3 s |
| Exclusivity (no double-booking) | All time | **100 %** | Zero tolerance — any failure is P0 |
| Escrow creation success | 28-day | **99.0 %** | 1 % |

> **Latency note.** 3 000 ms p99 matches `docs/CAPACITY_PLANNING.md §2.2`.
> The Stellar RPC and Trustless Work escrow API are synchronous in the current
> architecture; the 3 s budget reflects this. When the async queue is
> introduced (CAPACITY_PLANNING §7), lower the target to 1 000 ms.

### 4.3 Alert thresholds and burn-rate rules

| Severity | Condition | Window | Action |
|---|---|---|---|
| **P0 — Page immediately** | Any double-booking detected (exclusivity < 100%) | Real-time | Page IC + Finance Owner |
| **P1 — Page** | Availability burn rate ≥ 14× | 1 h | Page on-call |
| **P1 — Page** | `escrow_failures_total{operation="create"}` > 5 in 5 min | 5 min | Page on-call |
| **P1 — Page** | Booking p99 > 5 000 ms for 5 min | 5 min | Page on-call |
| **P2 — Ticket** | Availability burn rate ≥ 1× | 3 d | Create ticket |
| **P2 — Ticket** | Booking p99 > 3 000 ms for 30 min | 30 min | Create ticket |

**Critical escrow alert:**

```yaml
- alert: EscrowCreationFailureSpike
  expr: rate(escrow_failures_total{operation="create"}[5m]) > 5
  for: 0m
  labels:
    severity: critical
    journey: J3_booking
  annotations:
    summary: "J3 Booking: escrow creation failures > 5 in 5 min"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#3-payment--escrow-failure"

- alert: BookingAvailabilityFastBurn
  expr: |
    (1 - rate(http_requests_total{route="/api/v1/bookings",method="POST",status!~"5.."}[1h])
         / rate(http_requests_total{route="/api/v1/bookings",method="POST",status!~"(409|429)"}[1h]))
    > (14 * (1 - 0.99))
  for: 2m
  labels:
    severity: critical
    journey: J3_booking
  annotations:
    summary: "J3 Booking: fast burn rate ≥ 14×"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#3-payment--escrow-failure"
```

### 4.4 Responder

**Primary:** Backend On-Call.
**Escrow / payment failures:** Finance Owner paged concurrently for
`escrow_failures_total` alerts.
**P0 double-booking:** Incident Commander paged; Finance Owner and Contracts
Lead consulted.

### 4.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §3 — Payment / Escrow Failure](../apps/backend/RUNBOOKS.md#3-payment--escrow-failure)
- [`apps/backend/RUNBOOKS.md` §4 — Blockchain / Stellar RPC Connection Issues](../apps/backend/RUNBOOKS.md#4-blockchain--stellar-rpc-connection-issues)
- `docs/RECOVERY_RUNBOOK.md §4.8` — Compound booking + payment inconsistency

---

## 5. Journey J4 — Payment reconciliation (escrow)

**User story.** Every booking in a terminal state (`Confirmed`, `Completed`,
`Cancelled`) has a matching escrow record with the correct settlement status.
Finance reconciliation can confirm no orphaned or inconsistent escrows.

### 5.1 SLI definition

**Reconciliation success SLI:**

```
SLI_reconciliation =
  1 - (escrow_failures_total{operation=~"release|refund|cancel"}
       / escrow_operations_total{operation=~"release|refund|cancel"})
```

**Orphaned escrow SLI** (derived from DB, measured by periodic query):

```
SLI_orphan_escrow =
  1 - (
    count(bookings WHERE status IN ('Cancelled','Completed') AND escrow_id NOT IN
          (settled escrow IDs from Trustless Work))
    /
    count(bookings WHERE status IN ('Cancelled','Completed') AND escrow_id IS NOT NULL)
  )
  -- Target: 1.0 (zero orphans)
```

**Reconciliation latency SLI** (time from booking state change to escrow settled):

```
SLI_reconcile_latency =
  fraction of booking state changes where escrow settles within 15 min
```

Source: `blockchain_logs` table — `operation = 'escrow_release'` or
`'escrow_cancel'` with `created_at - booking.updated_at <= 900 s`.

### 5.2 SLO

| SLI | Window | Target | Error budget |
|---|---|---|---|
| Reconciliation success (release/refund/cancel) | 28-day | **99.5 %** | 0.5 % |
| Orphaned escrows | All time | **100 %** (zero orphans) | Zero tolerance |
| Reconciliation latency ≤ 15 min | 28-day | **99.0 %** | 1 % of state changes |

### 5.3 Alert thresholds and burn-rate rules

| Severity | Condition | Window | Action |
|---|---|---|---|
| **P0 — Page** | Any orphaned escrow detected | Real-time (daily reconciliation job) | Page Finance Owner + Backend On-Call |
| **P1 — Page** | `escrow_failures_total{operation=~"release|refund"}` > 3 in 5 min | 5 min | Page Finance Owner |
| **P1 — Page** | `payment_failures_total` > 3 in 5 min | 5 min | Page Finance Owner |
| **P1 — Page** | Reconciliation burn rate ≥ 14× | 1 h | Page Finance Owner |
| **P2 — Ticket** | Reconciliation burn rate ≥ 1× | 3 d | Create ticket |
| **P2 — Ticket** | Any booking in `escrow_reconcile_failed` state | Real-time (daily check) | Create ticket; Finance Owner notified |

**Escrow release failure alert:**

```yaml
- alert: EscrowReleaseFailure
  expr: rate(escrow_failures_total{operation=~"release|refund|cancel"}[5m]) > 3
  for: 0m
  labels:
    severity: critical
    journey: J4_reconciliation
  annotations:
    summary: "J4 Reconciliation: escrow release/refund/cancel failures > 3 in 5 min"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#3-payment--escrow-failure"

- alert: PaymentFailureSpike
  expr: rate(payment_failures_total[5m]) > 3
  for: 0m
  labels:
    severity: critical
    journey: J4_reconciliation
  annotations:
    summary: "J4 Reconciliation: payment failures > 3 in 5 min"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#3-payment--escrow-failure"
```

**Daily orphan check (run as a cron query or Supabase scheduled function):**

```sql
-- Alert if any row returned
SELECT b.id, b.status, b.escrow_id, b.updated_at
FROM bookings b
WHERE b.status IN ('Cancelled', 'Completed')
  AND b.status = 'escrow_reconcile_failed';
-- Also check for long-pending reconciliation
SELECT b.id, b.status, b.escrow_id, b.updated_at
FROM bookings b
WHERE b.escrow_id IS NOT NULL
  AND b.status IN ('Confirmed', 'Completed', 'Cancelled')
  AND b.updated_at < NOW() - INTERVAL '15 minutes'
  AND b.status != 'escrow_reconcile_failed'; -- not already quarantined
```

### 5.4 Responder

**Primary:** Finance Owner.
**Technical execution:** Backend On-Call.
**Stellar / TrustlessWork escalation:** Contracts Lead.

### 5.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §3 — Payment / Escrow Failure](../apps/backend/RUNBOOKS.md#3-payment--escrow-failure)
- [`docs/admin-runbooks.md` Runbook 7 — Reconciliation Review](./admin-runbooks.md#runbook-7--reconciliation-review)
- [`docs/admin-runbooks.md` Runbook 5 — Manual Refund Approval](./admin-runbooks.md#runbook-5--manual-refund-approval)
- `docs/RECOVERY_RUNBOOK.md §4.8` — Compound booking + payment inconsistency

---

## 6. Journey J5 — Notification delivery

**User story.** When a booking-lifecycle event occurs (booking created,
confirmed, cancelled, disputed, completed), both the tenant and host receive
an in-app notification, and — where email is enabled — an email notification,
within a reasonable time.

### 6.1 SLI definition

**In-app notification SLI:**

```
SLI_notification_inapp =
  count(notifications inserted within 60 s of the triggering booking event)
  /
  count(booking lifecycle events requiring notification)
```

Source: `notifications` table. A notification row is expected within 60 s of
the corresponding `bookings.updated_at` or `bookings.created_at`.

```sql
-- Fraction of booking events with a notification within 60 s (sample query)
SELECT
  COUNT(*) FILTER (
    WHERE n.created_at - b.updated_at <= INTERVAL '60 seconds'
  )::FLOAT / COUNT(*)
FROM bookings b
JOIN notifications n
  ON n.data->>'bookingId' = b.id::text
  AND n.type IN (
    'booking_created','booking_confirmed','booking_cancelled',
    'booking_completed','booking_disputed'
  )
WHERE b.updated_at > NOW() - INTERVAL '28 days';
```

**Email delivery SLI:**

```
SLI_notification_email =
  emails delivered without SMTP error
  /
  emails attempted

-- Proxy metric until dedicated email counter added:
rate(http_errors_total{route="/api/v1/notifications", status_class="5xx"}[5m])
```

> **Note.** A dedicated `notifications_sent_total{channel="email|inapp",outcome="success|failure"}`
> counter should be added to `metrics.middleware.ts` to make this SLI
> measurable without DB queries. This is tracked as a follow-up risk in §10.4.

### 6.2 SLO

| SLI | Window | Target | Error budget |
|---|---|---|---|
| In-app notification delivery within 60 s | 28-day | **99.0 %** | 1 % |
| Email notification delivery (no SMTP error) | 28-day | **98.0 %** | 2 % |

> **Rationale.** Email is lower-reliability than in-app because it depends on
> an external SMTP provider. The 98% email target reflects this reality and
> allows for transient SMTP provider outages. See `docs/RECOVERY_RUNBOOK.md §4.6`
> for the SMTP failover procedure.

### 6.3 Alert thresholds and burn-rate rules

| Severity | Condition | Window | Action |
|---|---|---|---|
| **P1 — Page** | Email send failures > 10 in 5 min (SMTP down) | 5 min | Page Email/Comms Owner |
| **P2 — Ticket** | In-app notification delivery burn rate ≥ 6× | 6 h | Create ticket |
| **P2 — Ticket** | Email delivery burn rate ≥ 6× | 6 h | Create ticket |
| **Info** | SMTP latency > 10 s for any individual email | Per-request | Log at `warn`; no alert |

**SMTP failure alert (proxy via HTTP errors on notification route):**

```yaml
- alert: NotificationEmailFailureSpike
  expr: |
    rate(http_errors_total{route="/api/v1/notifications", status_class="5xx"}[5m]) > 2
  for: 5m
  labels:
    severity: warning
    journey: J5_notifications
  annotations:
    summary: "J5 Notifications: notification endpoint 5xx spike — possible SMTP failure"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#1-api-outage--service-down"
```

> Once `notifications_sent_total` is added, replace the proxy with:
> `rate(notifications_sent_total{channel="email",outcome="failure"}[5m]) > 10`

### 6.4 Responder

**Primary:** Email/Comms Owner.
**Backend support:** Backend On-Call (for service-layer failures).

### 6.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §2 — High Error Rate](../apps/backend/RUNBOOKS.md#2-high-error-rate-5xx-spike)
- `docs/RECOVERY_RUNBOOK.md §4.6` — Email (SMTP) outage

---

## 7. Journey J6 — Blockchain sync lag

**User story.** On-chain booking and property state is reflected in the
Rentars database within a bounded time. A tenant whose booking is confirmed
on-chain sees the updated status in the UI promptly; a property whose
availability changes on-chain is reflected in search results promptly.

### 7.1 SLI definition

**Sync freshness SLI:**

```
SLI_sync_freshness =
  fraction of time where
  NOW() - MAX(sync_log.synced_at WHERE entity_type = 'booking')
  <= 120 seconds (2 min)
```

Source: `sync_log` table written by `src/services/sync.service.ts`.

```sql
-- Staleness check query (run every minute by alerting system)
SELECT
  EXTRACT(EPOCH FROM (NOW() - MAX(synced_at))) AS sync_lag_seconds,
  entity_type
FROM sync_log
WHERE entity_type IN ('booking', 'property')
GROUP BY entity_type;
-- Alert if sync_lag_seconds > 120 for bookings
-- Alert if sync_lag_seconds > 300 for properties
```

**RPC reliability SLI:**

```
SLI_rpc_reliability =
  rate(blockchain_rpc_calls_total{outcome="success"}[5m])
  /
  rate(blockchain_rpc_calls_total[5m])
```

**Sync failure SLI:**

```
SLI_sync_failure_rate =
  1 - (
    rate(sync_log failures WHERE status='failed'[1h])
    / rate(sync_log total[1h])
  )
```

Source: `sync_log` table, `status` column (`'success'|'failed'|'skipped'`).

### 7.2 SLO

| SLI | Window | Target | Error budget |
|---|---|---|---|
| Booking sync freshness (lag ≤ 120 s) | 28-day | **99.0 %** | 1 % ≈ 6 h 43 min |
| Property sync freshness (lag ≤ 300 s) | 28-day | **99.5 %** | 0.5 % |
| RPC call reliability | 28-day | **99.0 %** | 1 % |
| Sync success rate (no `failed` entries) | 28-day | **99.5 %** | 0.5 % |

> **Lag targets.** Bookings have a tighter lag budget (120 s) because stale
> booking state directly affects escrow settlement visibility. Properties
> allow 300 s because search-result staleness is less financially critical.

### 7.3 Alert thresholds and burn-rate rules

| Severity | Condition | Window | Action |
|---|---|---|---|
| **P1 — Page** | Booking sync lag > 10 min | 10 min | Page Backend On-Call |
| **P1 — Page** | `blockchain_rpc_calls_total{outcome="failure"}` > 3 in 1 min | 1 min | Page On-Call SRE |
| **P1 — Page** | RPC burn rate ≥ 14× | 1 h | Page On-Call SRE + Contracts Lead |
| **P2 — Ticket** | Booking sync lag > 2 min for 15 min | 15 min | Create ticket |
| **P2 — Ticket** | Property sync lag > 5 min for 20 min | 20 min | Create ticket |
| **P2 — Ticket** | Any booking in `escrow_reconcile_failed` state | Daily check | Finance Owner creates ticket |
| **Info** | `sync_log` `status='failed'` for any single entity | Per-event | Log; no alert unless pattern |

**RPC reliability alert:**

```yaml
- alert: BlockchainRpcFailureSpike
  expr: rate(blockchain_rpc_calls_total{outcome="failure"}[1m]) > 3
  for: 0m
  labels:
    severity: critical
    journey: J6_sync
  annotations:
    summary: "J6 Sync: Stellar RPC failures > 3 in 1 min"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#4-blockchain--stellar-rpc-connection-issues"

- alert: BlockchainRpcFastBurn
  expr: |
    (1 - rate(blockchain_rpc_calls_total{outcome="success"}[1h])
         / rate(blockchain_rpc_calls_total[1h]))
    > (14 * (1 - 0.99))
  for: 2m
  labels:
    severity: critical
    journey: J6_sync
  annotations:
    summary: "J6 Sync: RPC fast burn rate ≥ 14×"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#4-blockchain--stellar-rpc-connection-issues"

- alert: BookingSyncStaleness
  expr: |
    (time() - on() booking_sync_last_success_timestamp) > 600
  for: 0m
  labels:
    severity: critical
    journey: J6_sync
  annotations:
    summary: "J6 Sync: booking sync has not succeeded for > 10 min"
    runbook: "https://github.com/Mansa147/Rentars/blob/main/apps/backend/RUNBOOKS.md#4-blockchain--stellar-rpc-connection-issues"
```

> `booking_sync_last_success_timestamp` is a gauge that the sync service
> should emit. Add `observeGauge('booking_sync_last_success_timestamp', {}, Date.now() / 1000)`
> to `sync.service.ts` after each successful `writeSyncLog` for `entity_type='booking'`.

### 7.4 Responder

**Primary:** Backend On-Call (sync service).
**RPC / blockchain failures:** Contracts Lead paged concurrently.
**Orphaned escrow fallout:** Finance Owner.

### 7.5 Linked runbooks

- [`apps/backend/RUNBOOKS.md` §4 — Blockchain / Stellar RPC Connection Issues](../apps/backend/RUNBOOKS.md#4-blockchain--stellar-rpc-connection-issues)
- [`apps/backend/RUNBOOKS.md` §3 — Payment / Escrow Failure](../apps/backend/RUNBOOKS.md#3-payment--escrow-failure)
- `docs/RECOVERY_RUNBOOK.md §4.4` — Smart contract failure
- `docs/RECOVERY_RUNBOOK.md §4.5` — RPC provider outage

---

## 8. Error budget policy

The error budget is the quantified licence to take risk. When the budget is
being consumed faster than planned, the team's first obligation is reliability,
not feature velocity.

### 8.1 Budget states

| State | Condition | Effect |
|---|---|---|
| **Green** | Remaining budget > 50 % of window | Full release velocity; no restrictions |
| **Yellow** | Remaining budget 25–50 % | Releases require: (a) a passing load test, (b) explicit sign-off from the SLO owner listed in §11. New features that touch the affected journey require extra review. |
| **Orange** | Remaining budget 10–25 % | Releases frozen for the affected journey unless the change is a reliability fix. Incident review required before resuming velocity. |
| **Red** | Remaining budget < 10 % or any P0 event | All feature releases halted for the affected journey. On-call leads a reliability sprint. Re-evaluation after budget refills above 25 %. |

### 8.2 Release gate in practice

Before every production deployment, the release manager checks:

```bash
# Example: check current error budget consumption for J3 (booking)
# Calculate: bad_requests / allowed_bad_requests_for_window
# allowed = total_requests_28d * (1 - SLO) = total * 0.01

# In Prometheus:
# bad = increase(http_errors_total{route="/api/v1/bookings",method="POST"}[28d])
# total = increase(http_requests_total{route="/api/v1/bookings",method="POST",
#                                       status!~"(409|429)"}[28d])
# budget_consumed = bad / (total * 0.01)
```

If `budget_consumed > 0.75` (Yellow → Orange boundary) the release is held
until the affected SLO owner approves.

### 8.3 P0 (zero-tolerance) events

The following events bypass the budget calculation and trigger an immediate
release hold regardless of remaining budget:

| Event | Journey | Trigger |
|---|---|---|
| Double-booking detected | J3 | Any row with overlapping `check_in/check_out` for same `property_id` in `Confirmed/Pending` state |
| Orphaned escrow detected | J4 | Any `escrow_reconcile_failed` booking or unmatched escrow |
| Data integrity failure in `bookings` or `payments` | J3, J4 | Inconsistency detected by reconciliation job |

### 8.4 Budget consumption reporting

The release manager reviews budget consumption at each sprint retro and at
every launch-readiness review (see `LAUNCH_READINESS.md` §8). A dashboard
showing current budget consumption per journey is the single source of truth.
The recommended dashboard query per journey is included in the alert rules
above.

---

## 9. Alert implementation guide

### 9.1 Alert testing procedure

Every alert rule must pass this test before going live:

1. **Unit test the PromQL.** Run the alert expression against a copy of the
   production (or staging) metrics dataset with injected synthetic failures.
   Verify it fires within the stated `for` window.

2. **Silence test.** Inject a single spike that does not cross the threshold.
   Verify the alert does **not** fire.

3. **Recovery test.** Fire the alert, then fix the injected condition. Verify
   the alert resolves within 2× the evaluation interval.

4. **Runbook reachability.** Confirm the `runbook` annotation URL is
   accessible and points to the correct section.

5. **Routing test.** Verify the alert routes to the correct receiver
   (PagerDuty policy, Slack channel, email) by firing it in a staging
   Alertmanager with a test receiver.

Record each test result in the alert's `annotations.tested_on` field.

### 9.2 Alert routing matrix

| Journey | Severity | Routing target |
|---|---|---|
| J1 Availability | Critical | PagerDuty `rentars-platform` → On-Call SRE |
| J1 Availability | Warning | Slack `#ops-alerts` |
| J2 Search | Critical | PagerDuty `rentars-backend` → Backend On-Call |
| J2 Search | Warning | Slack `#ops-alerts` |
| J3 Booking | Critical | PagerDuty `rentars-backend` + `rentars-finance` (parallel) |
| J3 Booking — P0 exclusivity | Critical | PagerDuty `rentars-incident-command` (all owners) |
| J4 Reconciliation | Critical | PagerDuty `rentars-finance` → Finance Owner |
| J4 Reconciliation — P0 orphan | Critical | PagerDuty `rentars-incident-command` |
| J5 Notifications | Warning | Slack `#ops-alerts` + email to Email/Comms Owner |
| J6 Sync | Critical | PagerDuty `rentars-backend` + `rentars-blockchain` (parallel) |

### 9.3 Actionability checklist

An alert is actionable only when:

- [ ] The alert name uniquely identifies the journey and condition.
- [ ] The `runbook` annotation links to a section that has specific CLI
      commands, not just general guidance.
- [ ] The alert fires before the error budget is fully exhausted (not after).
- [ ] The firing condition is reproducible in staging.
- [ ] There is a clear "resolved" condition that auto-resolves the alert.
- [ ] The on-call responder has been briefed on the runbook.

---

## 10. Baseline establishment and review cadence

### 10.1 Load-test certification gate

Before the first production release, the following measured baselines must
be entered in `docs/CAPACITY_PLANNING.md §5`:

| Measurement | Target | Evidence required |
|---|---|---|
| Search cold p99 at 10 k listings | < 200 ms | k6 report at 200 VUs |
| Search cached p99 at 10 k listings | < 50 ms | k6 report with Redis warm |
| Booking creation p99 | < 3 000 ms | k6 report at 20 VUs |
| RPC contribution to booking latency | Measured and recorded | k6 with mocked TrustlessWork |
| Sync lag under load | < 120 s at 20 concurrent booking VUs | Verified from `sync_log` during k6 run |

**Gate condition.** If any measured value exceeds its target, the SLO
thresholds in this document must be revised upward **before** the release,
not after. The revision requires the SLO owner's sign-off.

### 10.2 Testnet certification gate

After 2 weeks of testnet operation:

- Record the actual p99 and error rates for each journey from the testnet
  Prometheus data.
- If actual error rates are within 2× of the SLO target, the targets stand.
- If actual error rates exceed 3× the SLO target, revise the target
  downward, identify the root cause, and file a remediation ticket before
  mainnet.
- Update the "Measured baseline" column in the table below.

### 10.3 Quarterly review

| Review event | Owner | Checklist |
|---|---|---|
| Quarterly SLO review | Incident Commander | Review actual vs. target for all 6 journeys; revise targets based on actual baselines; update §10.4 follow-up risks; record in this doc |
| Post-release SLO check | Release Manager | Within 48 h of each production release, verify no journey has entered Yellow/Orange budget state |
| Benchmark drift check | DBA / Backend On-Call | Quarterly: re-run abbreviated k6 search benchmark; update `docs/CAPACITY_PLANNING.md §5.1` |

### 10.4 Follow-up risks (open at document creation)

Every open item has an owner and a due date. The Incident Commander closes
each item before the next quarterly review.

| # | Risk / gap | Journey | Owner | Due date | Status |
|---|---|---|---|---|---|
| 1 | No dedicated `notifications_sent_total{channel, outcome}` counter — email delivery SLI uses a proxy metric. Add to `metrics.middleware.ts`. | J5 | Backend On-Call | 2026-11-15 | Open |
| 2 | `booking_sync_last_success_timestamp` gauge not yet emitted by `sync.service.ts`. Required for the `BookingSyncStaleness` alert rule. Add `observeGauge` after each successful booking sync write. | J6 | Backend On-Call | 2026-11-15 | Open |
| 3 | In-app notification delivery SLI requires a DB query — not yet a Prometheus metric. Consider adding a `notification_created_total{type}` counter to `notification.service.ts`. | J5 | Backend On-Call | 2026-12-01 | Open |
| 4 | Measured baselines in `docs/CAPACITY_PLANNING.md §5` are all "not yet measured". Load-test run required before first production release. | J2, J3 | DBA / Backend On-Call | Before launch | Open |
| 5 | Alert routing matrix (§9.2) uses placeholder PagerDuty policy names. Wire to actual PagerDuty service IDs before alert rules go live. | All | On-Call SRE | 2026-11-01 | Open |
| 6 | Orphaned escrow detection query runs as a manual check. Automate as a Supabase scheduled function or cron job with Alertmanager webhook. | J4 | Finance Owner | 2026-12-01 | Open |

---

## 11. Owner registry

| Role | Responsibilities on this document | On-call schedule |
|---|---|---|
| **Incident Commander** | SLO quarterly review; release go/no-go; P0 escalation | PagerDuty `rentars-incident-command` |
| **On-Call SRE** | J1 primary responder; J6 RPC failures | PagerDuty `rentars-platform` (rotating) |
| **Backend On-Call** | J2, J3 primary; J6 sync primary | PagerDuty `rentars-backend` (rotating) |
| **DBA (Database Owner)** | J1 database dep; J2 index/query escalation; load-test baselines | Escalation from Backend On-Call |
| **Finance Owner** | J4 primary; J3 escrow alerts; P0 double-booking | PagerDuty `rentars-finance` |
| **Contracts Lead** | J6 RPC escalation; J3 contract-related failures | PagerDuty `rentars-blockchain` |
| **Email/Comms Owner** | J5 primary | Slack `#ops-alerts` + email rotation |
| **Release Manager** | Error-budget gate enforcement; post-release checks | Per-release assignment |

---

## Appendix A — SLO summary table

| Journey | SLI | 28-day target | Error budget | Primary responder |
|---|---|---|---|---|
| J1 Availability | `GET /health` success rate | **99.5 %** | 3 h 21 min | On-Call SRE |
| J2 Search | Search 5xx rate | **99.5 %** | 3 h 21 min | Backend On-Call |
| J2 Search | p99 latency ≤ 500 ms | **95.0 %** | 5 % of requests | Backend On-Call |
| J3 Booking | Booking 5xx rate (excl. 409/429) | **99.0 %** | 6 h 43 min | Backend On-Call |
| J3 Booking | p99 latency ≤ 3 000 ms | **95.0 %** | 5 % of requests | Backend On-Call |
| J3 Booking | Exclusivity (no double-booking) | **100.0 %** | Zero tolerance | IC + Finance |
| J3 Booking | Escrow creation success | **99.0 %** | 1 % | Finance Owner |
| J4 Reconciliation | Release/refund/cancel success | **99.5 %** | 0.5 % | Finance Owner |
| J4 Reconciliation | Zero orphaned escrows | **100.0 %** | Zero tolerance | Finance Owner |
| J4 Reconciliation | Settle within 15 min | **99.0 %** | 1 % | Finance Owner |
| J5 Notifications | In-app delivery within 60 s | **99.0 %** | 1 % | Email/Comms Owner |
| J5 Notifications | Email delivery (no SMTP error) | **98.0 %** | 2 % | Email/Comms Owner |
| J6 Sync | Booking sync lag ≤ 120 s | **99.0 %** | 1 % | Backend On-Call |
| J6 Sync | Property sync lag ≤ 300 s | **99.5 %** | 0.5 % | Backend On-Call |
| J6 Sync | RPC call reliability | **99.0 %** | 1 % | Contracts Lead |

---

## Appendix B — Metric naming quick reference

| Metric name | Type | Key labels | Used in journey |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` | J1, J2, J3 |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status` | J2, J3 |
| `http_errors_total` | counter | `method`, `route`, `status_class` | J1, J2, J3 |
| `bookings_created_total` | counter | — | J3 |
| `escrow_operations_total` | counter | `operation` | J3, J4 |
| `escrow_failures_total` | counter | `operation` | J3, J4 |
| `payment_failures_total` | counter | `reason` | J4 |
| `blockchain_rpc_calls_total` | counter | `method`, `outcome` | J6 |
| `blockchain_rpc_duration_seconds` | histogram | `method` | J6 |
| `probe_runs_total` | counter | `suite`, `outcome` | J1 |
| `probe_duration_seconds` | histogram | `suite`, `target` | J1, J2 |
| `notifications_sent_total` ⚠ | counter | `channel`, `outcome` | J5 — **not yet emitted** (§10.4 risk #1) |
| `booking_sync_last_success_timestamp` ⚠ | gauge | — | J6 — **not yet emitted** (§10.4 risk #2) |
| `notification_created_total` ⚠ | counter | `type` | J5 — **not yet emitted** (§10.4 risk #3) |

⚠ = metric does not yet exist in the codebase; tracked as follow-up risk in §10.4.
