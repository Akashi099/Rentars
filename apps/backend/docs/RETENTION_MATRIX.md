# Data Retention Matrix

This matrix is the source of truth for what the automated retention sweep
(`src/services/retention.service.ts`, scheduled by `src/services/cleanup-schedular.ts`)
is allowed to delete or anonymise, and what must be preserved.

## Rules

- **Batched**: at most `RETENTION_BATCH_SIZE` (default 500) rows per class per run.
- **Dependency-safe order**: child rows are deleted before parents.
- **Legal holds**: any `(entity_type, entity_id)` in `legal_holds` where
  `active = true` is exempt. See migration `00062_add_legal_holds.sql`.
- **Dispute-safe**: bookings/payments in `Disputed` status and confirmed
  financial records are never deleted.
- **Observable**: every run emits a structured summary (per-class counts,
  elapsed time, failures) and supports `{ dryRun: true }` preview.
- **Idempotent**: jobs are safe to re-run; partial failures are recorded per
  class and retried on the next sweep.

## Matrix

| Class | Table(s) | Default window | Action | Preserved |
|---|---|---|---|---|
| wallet_challenges | `wallet_challenges` | 1 hour | delete | held |
| password_reset_tokens | `password_reset_tokens` | 7 days | delete | held |
| idempotency_keys | `idempotency_keys` | 24 hours | delete | held |
| blockchain_logs | `blockchain_logs` | 90 days | delete | held, audit |
| sync_log | `sync_log` | 30 days | delete | — |
| notifications (read) | `notifications` | 90 days | delete | held |
| notifications (unread) | `notifications` | 180 days | delete | held |
| search_analytics | `search_analytics` | 365 days | delete | — |
| property_views | `property_views` | 90 days | delete rows (aggregates kept) | — |
| data_exports | `data_exports` | per expiry | delete | held |
| account_deletions | `account_deletions` | 30 days | delete (completed/cancelled) | held |
| soft_deleted_props | `properties` | 180 days | delete (`deleted_at IS NOT NULL`) | held, active dispute |
| payments_failed | `payments` | 90 days | delete (failed/timed_out) | active dispute, held |
| payments (confirmed) | `payments` | — | **preserve** (7-year financial) | always |
| bookings (escrow) | `bookings` | — | **preserve** (financial/legal) | always |
| audit_logs | `audit_logs` | — | **preserve** | always |
| legal_holds / legal_hold_log | `legal_holds`, `legal_hold_log` | — | **preserve** while active | always |

## Configuration

All windows are overridable via `RETENTION_*` env vars (see `src/config/env.ts`).
`RETENTION_INTERVAL_HOURS` (default 24) controls sweep frequency and
`RETENTION_RUN_ON_STARTUP=true` triggers an immediate live run after a
policy change. A dry-run preview always fires shortly after startup.

## Operator verification

- Startup dry-run preview logs eligible counts without mutating data.
- Each run logs `failed_classes` and per-class counts for auditing.
- To preview manually, call `runDataRetention({ dryRun: true })`.
