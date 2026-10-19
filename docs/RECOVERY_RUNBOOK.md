# Rentars Recovery Runbook

This runbook is the authoritative procedure for recovering the Rentars platform
from outages that span **database, object storage, Redis, smart contracts, RPC
providers, email, and frontend releases**. Restoring only one component can
leave bookings and payments inconsistent, so every recovery ends with the
booking-lookup and payment-reconciliation verification in §6.6 and §6.7.

> **Read before acting.** Recovery actions are logged to `audit_logs` and to
> the incident record. HIGH-RISK actions (database restore, contract ID switch,
> JWT secret rotation) require dual approval — see §3. USDC movements on
> Stellar are irreversible; never run reconciliation against mainnet without
> the Finance owner on the call.

---

## 1. Purpose & scope

**In scope:** recovery of read and write paths for properties, bookings,
escrow, notifications, and the frontend that serves them.

**Out of scope:** feature development, capacity planning (see
[`docs/CAPACITY_PLANNING.md`](./CAPACITY_PLANNING.md)), security incident
forensics (see [`docs/INCIDENT_REVIEW_TEMPLATE.md`](./INCIDENT_REVIEW_TEMPLATE.md)).

**Companion documents:**

| Doc | Use for |
|---|---|
| [`docs/backup-restore-verification.md`](./backup-restore-verification.md) | Database-only restore drill detail |
| [`scripts/backup-restore-drill.sh`](../scripts/backup-restore-drill.sh) | Database restore drill script |
| [`docs/admin-runbooks.md`](./admin-runbooks.md) | Per-action admin procedures (suspend, refund, session revoke) |
| [`docs/releases/rollback.md`](./releases/rollback.md) | Release manifest selection and rollback |
| [`DEPLOYMENT.md`](../DEPLOYMENT.md) §7 | Rollback procedures and health gates |
| [`infra/environments/*/secrets.reference.md`](../infra/environments/) | Secret rotation procedures |

---

## 2. Recovery objectives

Recovery Time Objective (RTO) = max acceptable time to restore a component
after detection. Recovery Point Objective (RPO) = max acceptable data loss
measured backwards from the outage.

| # | Component | RTO target | RPO target | Backup cadence | Backup location |
|---|---|---|---|---|---|
| 1 | Database (Supabase / Postgres) | 30 min | 5 min | Continuous PITR + daily snapshot | Supabase-managed + cross-region replica |
| 2 | Object storage (Supabase Storage) | 1 h | 24 h | Daily bucket snapshot | Supabase Storage backup + S3 mirror |
| 3 | Redis cache | 5 min | 0 (rebuildable) | None — cache is derived | Rebuilt from Postgres on cold start |
| 4 | Smart contracts (Soroban) | n/a — immutable | 0 — on-chain state is permanent | WASM + ABI committed to git | `apps/contracts/` + release manifests |
| 5 | RPC providers (Stellar) | 2 min | n/a — read-only | n/a | Primary + 2 backup RPC URLs (see §5.3) |
| 6 | Email (SMTP) | 15 min | 0 (queueable) | n/a | Primary SMTP + fallback relay |
| 7 | Frontend releases (Vercel) | 5 min | n/a — stateless | Every deploy is a rollback target | Vercel deployment history |

**Aggregate recovery target.** After detection of a multi-component outage,
the platform must serve **core reads within 35 min** and **booking lookup and
payment reconciliation within 45 min** — see §6 for the drill that proves this.

---

## 3. Owners (RACI)

R = Responsible (does the work), A = Accountable (signs off, single name),
C = Consulted, I = Informed. Substitute named individuals on the live on-call
rota; the roles below are the authoritative owner slots.

| Scenario (§4) | Accountable (A) | Responsible (R) | Consulted (C) | Informed (I) |
|---|---|---|---|---|
| 4.1 Database outage | Database Owner (DBA) | On-Call SRE | Backend On-Call, Infra Owner | Support, Finance |
| 4.2 Object storage outage | Storage Owner | On-Call SRE | Backend On-Call | Support |
| 4.3 Redis outage | Backend On-Call | On-Call SRE | DBA | — |
| 4.4 Smart contract failure | Contracts Lead | Backend On-Call | Infra Owner, Finance | Support |
| 4.5 RPC provider outage | Infra Owner (RPC) | On-Call SRE | Contracts Lead | Backend On-Call |
| 4.6 Email outage | Email/Comms Owner | On-Call SRE | Backend On-Call | Support |
| 4.7 Frontend release failure | Frontend On-Call | On-Call SRE | Backend On-Call | Support |
| 4.8 Booking + payment inconsistency | Finance Owner | Backend On-Call | DBA, Contracts Lead | Support, Incident Commander |
| §6 Drill | Incident Commander | On-Call SRE | All component owners | Engineering Manager |

**Dual approval** is required for: database restore to production, contract ID
switch, JWT secret rotation, manual USDC refund (see
[`docs/admin-runbooks.md`](./admin-runbooks.md) Runbook 5). The approver is any
A-row owner who is **not** the R for the same action.

**On-call rota.** The current week's on-call is published in PagerDuty schedule
`rentars-platform`. The Incident Commander is whichever on-call engineer
acknowledges the page first; they hand off only at a natural breakpoint.

---

## 4. Outage scenarios

Each scenario below lists: detection signal, owner, exact steps, verification,
and rollback. Steps are numbered so they can be read aloud during a call.

### 4.1 Database outage (Supabase / Postgres)

**Detection.** `GET /health/deep` returns `database: disconnected`; or
`pg_connection_errors` > 0 for 2 min; or Supabase status page reports an
incident; or any API write returns `503` with `SUPABASE_ERROR`.

**Owner (A):** Database Owner (DBA). **R:** On-Call SRE.

**Steps.**

1. Acknowledge the page and open an incident record using
   [`docs/INCIDENT_REVIEW_TEMPLATE.md`](./INCIDENT_REVIEW_TEMPLATE.md).
2. Confirm scope: read `GET /health/deep` and the Supabase status page. If
   Supabase is at fault, follow their incident — do not restore into a live
   primary.
3. Decide: **fail over to replica** (preferred, < 60 s) or **restore from
   backup** (see §6.2). Choose failover if the replica lag is within RPO
   (5 min); choose restore only if the primary is corrupt.
4. **Failover** (Supabase dashboard → Database → Promote replica). Wait for
   DNS to converge (typically < 60 s). Update `SUPABASE_URL` only if the
   hostname changed.
5. **Restore path** — get dual approval from a second owner, then run the
   drill-verified procedure in §6.2 against the **non-production** verification
   database first, validate, then promote.
6. Once writes succeed, resume the blockchain sync service — see §6.4 — and
   run payment reconciliation — see §6.7.

**Verification.** `GET /health/deep` returns `database: connected`; a representative
`SELECT id, email FROM users LIMIT 1` returns a row; `bookings` and `payments`
row counts match the pre-incident snapshot within RPO.

**Rollback.** A restored database cannot be "un-restored". If the restore is
wrong, **stop writes immediately**, preserve the restored DB as evidence, and
restore from the next-older backup. Document every restore in the incident
record with the backup ID and timestamp.

---

### 4.2 Object storage outage (Supabase Storage)

**Detection.** Property image uploads return `502`/`503`; or image URLs
return `404` at scale; or Supabase Storage status page reports an incident.

**Owner (A):** Storage Owner. **R:** On-Call SRE.

**Steps.**

1. Confirm the outage is storage, not CDN: `curl -I` against a known image URL
   directly on the storage hostname.
2. Switch the backend `SUPABASE_STORAGE_URL` to the S3 mirror (read-only) for
   serving existing images — see §5.2 for the mirror reference.
3. **Pause new uploads** by setting the `PROPERTY_UPLOADS_ENABLED` feature
   flag to `false` (LaunchDarkly or env). Reads continue from the mirror.
4. If the bucket is deleted or corrupt, restore from the daily snapshot:
   Supabase dashboard → Storage → Restore bucket → choose snapshot.
5. Reconcile any uploads that succeeded during the outage but were not
   mirrored: query `property_images` for rows with `mirror_synced = false` and
   re-upload from the backend's temporary upload cache.

**Verification.** A random sample of 20 `property_images.url` rows returns
`200 OK`; a test upload of a 1 KB image succeeds and is mirrored within 5 min.

**Rollback.** Re-enable `PROPERTY_UPLOADS_ENABLED` after the mirror is drained.

---

### 4.3 Redis outage (cache)

**Detection.** `redis_connected_clients` drops to 0; or `redis_command_failures`
> 0 for 1 min; or `GET /health/deep` returns `redis: disconnected`.

> The application is designed to operate with Redis unavailable — cache
> misses fall through to Postgres (see `cache.service.ts` `ensureConnected`).
> This scenario is about restoring normal performance, not correctness.

**Owner (A):** Backend On-Call. **R:** On-Call SRE.

**Steps.**

1. Confirm Redis is down vs. network partition: `redis-cli -h $REDIS_HOST ping`
   from the backend host.
2. If managed Redis (ElastiCache/Upstash), check the provider status page and
   trigger a failover to the read-replica from the provider console.
3. If self-hosted, restart the Redis container: `docker compose restart redis`.
4. **Rebuild the cache** by warming the hot keys — see §6.3.
5. Verify the rate-limit store has recovered; the rate limiter falls back to
   in-memory if Redis is down, so per-instance counters may have reset.

**Verification.** `GET /health/deep` returns `redis: connected`; `redis-cli INFO`
shows `connected_clients > 0`; cache hit rate returns to baseline within 10 min.

**Rollback.** None — Redis is a cache; `FLUSHDB` is safe if a corrupt key is
suspected. Sessions are JWT-based, not Redis-based, so users are not logged out.

---

### 4.4 Smart contract failure (Soroban)

**Detection.** Contract invocation failure rate > 1% for 2 min (DEPLOYMENT.md
§7.6.6 health gate); or `sync.service.ts` writes `status='failed'` to
`sync_log` for > 5 bookings in 5 min; or `reconcilePendingEscrow` returns
`success=false` for an unbroken chain of attempts.

> Soroban contracts are immutable. Recovery means deploying a patched
> contract and re-pointing the backend's contract IDs, not "rolling back" the
> on-chain code.

**Owner (A):** Contracts Lead. **R:** Backend On-Call.

**Steps.**

1. Identify the failing contract from the audit log: `action = contract.*`
   and the error category from `sync.service.ts classifyError`.
2. If the failure is a contract bug, freeze the affected flow via feature flag
   (e.g. `BOOKING_CREATION_ENABLED=false`) to prevent new bad state.
3. Build and deploy a patched contract — see `apps/contracts/DEPLOY.md` and
   `DEPLOYMENT.md` §3.2. Capture the new contract ID.
4. Get dual approval (Contracts Lead A + a second owner) to switch
   `PROPERTY_LISTING_CONTRACT_ID` / `BOOKING_CONTRACT_ID` /
   `REVIEW_CONTRACT_ID` in the secrets provider. Redeploy the backend.
5. Run `syncAllProperties` and `syncAllBookings` (see §6.4) to reconcile
   off-chain state against the new contract(s).
6. For any bookings quarantined in `escrow_reconcile_failed` (see
   `sync.service.ts` `quarantineBooking`), re-run reconciliation after the
   fix and notify tenant + host per the notification flow.

**Verification.** Contract invocation success rate > 99% for 10 min; no new
`sync_log` rows with `status='failed'`; the booking lookup test in §6.6 passes
for a sample that includes at least one previously quarantined booking.

**Rollback.** Re-point the contract IDs back to the previous values (recorded
in the release manifest — see §5.1). On-chain state created under the new
contract is **not** rolled back; document this in the incident record.

---

### 4.5 RPC provider outage (Stellar RPC)

**Detection.** `stellar_rpc_request_failures > 0` for 1 min; or
`getSorobanServer()` health check in `/health/deep` fails; or the sync
service falls behind by > 30 ledgers.

**Owner (A):** Infra Owner (RPC). **R:** On-Call SRE.

**Steps.**

1. Confirm the outage is RPC, not the contract: switch `STELLAR_RPC_URL` to
   the first backup URL (see §5.3) and re-test. No redeploy is needed if the
   URL is read from a config refresh (otherwise a rolling restart is required).
2. If the primary RPC recovers, fail back to it for cost reasons only after it
   has been healthy for 30 min.
3. If all configured RPCs are degraded, switch the backend to **degraded
   mode**: `BOOKING_CREATION_ENABLED=false` (bookings need on-chain escrow),
   keep read paths up (properties are cached in Postgres). Notify users via
   the status page.
4. When RPC recovers, run the sync-resume procedure in §6.4 to catch up.

**Verification.** `GET /health/deep` returns `stellar: connected` from the
active RPC; sync lag < 5 ledgers; the booking-lookup test in §6.6 passes for
a booking created in the last hour.

**Rollback.** Revert `STELLAR_RPC_URL` to the primary. No data is lost — RPC
is read-only against the ledger.

---

### 4.6 Email outage (SMTP)

**Detection.** `email_send_failures > 0` for 5 min; or `notification.service`
writes `status='failed'` for email channel for > 10 messages in 10 min; or
SMTP provider status page reports an incident.

> Email is async and queueable. No transaction is blocked by an email outage;
> notifications are retried from the `notifications` table.

**Owner (A):** Email/Comms Owner. **R:** On-Call SRE.

**Steps.**

1. Confirm the outage is SMTP, not the backend: tail the email service log
   for `SMTP_*` errors vs. application errors.
2. Switch `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` to the
   fallback relay (see §5.4) in the secrets provider. Redeploy the backend.
3. Drain the retry queue: the `notifications` table holds rows with
   `status='pending'` and `channel='email'`. The reminder service
   (`reminder.service.ts`) will pick them up on its next tick (every 60 s).
4. For time-sensitive notifications (password reset, booking confirmation),
   verify delivery on a sample of 5 messages after the switch.

**Verification.** A test email to `ops+drill@rentars.app` arrives within 60 s;
the `notifications` queue depth returns to baseline; no `status='failed'`
rows for `channel='email'` for 10 min.

**Rollback.** Revert SMTP credentials to the primary after it recovers.

---

### 4.7 Frontend release failure (Vercel)

**Detection.** Error rate on the frontend > 5% for 2 min (DEPLOYMENT.md
§7.6.1 health gate); or a release health gate fails; or user reports of a
blank/error page at scale.

**Owner (A):** Frontend On-Call. **R:** On-Call SRE.

**Steps.**

1. Identify the last known-good deployment in Vercel → Deployments.
2. Promote it to production (Vercel → "Instant Rollback"). This is a single
   click and typically completes in < 60 s.
3. If the failure was caused by an env var change, revert the env var in
   Vercel and trigger a redeploy of the rolled-back commit.
4. If the failure was caused by a backend API change, coordinate with the
   Backend On-Call — the backend may also need rollback per DEPLOYMENT.md §7.1.

**Verification.** Frontend error rate < 1% for 5 min; the smoke suite in
`docs/releases/rollback.md` step 5 passes; a booking-creation click-through
succeeds on a real browser.

**Rollback.** Re-promote the failed deployment only after the root cause is
fixed and a new release passes health gates in staging first.

---

### 4.8 Compound: booking + payment inconsistency

> This is the scenario the runbook exists for. Restoring only the database or
> only the contract leaves bookings and escrows inconsistent. The procedure
> below is the canonical path back to consistency.

**Detection.** Reconciliation review
([`docs/admin-runbooks.md`](./admin-runbooks.md) Runbook 7) finds orphaned
escrows; or `reconcilePendingEscrow` returns `success=false` repeatedly; or
Finance reports a booking marked `Completed` with no matching escrow release.

**Owner (A):** Finance Owner. **R:** Backend On-Call. **C:** DBA, Contracts
Lead.

**Steps.**

1. Freeze new bookings (`BOOKING_CREATION_ENABLED=false`) and new escrow
   releases until consistency is restored.
2. Export the inconsistent set: bookings where `status` does not match the
   on-chain escrow state.
   ```sql
   SELECT b.id, b.status, b.escrow_id, b.on_chain_id, b.total_price
   FROM bookings b
   WHERE b.status IN ('Confirmed','Completed','Cancelled')
     AND b.escrow_id IS NOT NULL
   ORDER BY b.created_at DESC;
   ```
3. For each row, call `syncBookingFromChain(b.on_chain_id)` to refresh the
   DB status from the ledger (source of truth for escrow).
4. For rows still inconsistent after sync, call `reconcilePendingEscrow`
   (see `sync.service.ts`), which classifies the failure (transient vs.
   permanent) and either retries with exponential backoff or quarantines the
   booking in `escrow_reconcile_failed`.
5. For quarantined bookings, raise a Trustless Work support ticket with the
   booking ID, escrow ID, and the `audit_logs` excerpt. Do not manually move
   USDC.
6. Once the consistent set is empty, lift the booking freeze and notify users
   whose bookings were delayed.

**Verification.** §6.7 (payment reconciliation verification) passes with zero
discrepancies on the re-run; the §6.6 booking-lookup test passes for the
previously inconsistent set.

**Rollback.** N/A — the on-chain state is the source of truth. If a
reconciliation action moved USDC incorrectly, file a Trustless Work ticket
and a Finance incident; USDC transfers are irreversible.

---

## 5. Backup & contract references

### 5.1 Release manifests

Every release writes a manifest to `docs/releases/manifest-<version>.json`
capturing commit SHA, Docker image tag, latest migration, contract IDs, and
ABI SHA-256 hashes. The manifest is the source of truth for "what was live"
during recovery — see [`docs/releases/rollback.md`](./releases/rollback.md).

```bash
# List manifests newest-first
ls -1t docs/releases/manifest-*.json

# Find the manifest that was live at a given incident time
jq -r '. | "\(.version) \(.released_at) \(.components.contracts.booking.id)"' \
  docs/releases/manifest-*.json | sort -k2
```

### 5.2 Object storage backup references

| Item | Location | Refresh |
|---|---|---|
| Primary bucket | Supabase Storage — `property-images` | Live |
| Mirror bucket | AWS S3 — `rentars-property-images-mirror` (read-only) | Daily sync from primary |
| Snapshot | Supabase Storage → Snapshots | Daily 02:00 UTC |

The mirror is the read path during a primary outage (§4.2 step 2).

### 5.3 RPC provider references

The backend reads `STELLAR_RPC_URL` from the secrets provider. Operators keep
three URLs on file; only one is active at a time.

| Priority | Provider | Used for | Failover trigger |
|---|---|---|---|
| 1 | `https://soroban-mainnet.stellar.org` (official) | Default mainnet | Provider status page incident |
| 2 | Backup RPC #1 (record in `infra/environments/production/secrets.reference.md`) | Failover | Primary down or lag > 30 ledgers |
| 3 | Backup RPC #2 (record in same file) | Secondary failover | Both #1 and #2 down |

For testnet, substitute `https://soroban-testnet.stellar.org` and any
testnet backups. Add the backup URLs to the secrets reference doc when set.

### 5.4 Email provider references

| Priority | Provider | Failover trigger |
|---|---|---|
| 1 | Primary SMTP (record host/user in secrets provider) | `email_send_failures > 0` for 5 min |
| 2 | Fallback relay (record host/user in secrets provider) | Primary down |

### 5.5 Contract & key references

| Reference | Where it lives | Owner |
|---|---|---|
| Deployed contract IDs (property, booking, review) | `infra/environments/{env}/secrets.reference.md` + release manifest | Contracts Lead |
| Contract WASM + ABI | `apps/contracts/target/...release/*.wasm` + `apps/contracts/.../*.abi.json` | Contracts Lead |
| ABI SHA-256 hashes | Release manifest `contracts.abi_sha256` | Contracts Lead |
| Deployment admin key | `STELLAR_ADMIN_SECRET` in secrets provider (two-person rule) | Contracts Lead + Infra Owner |
| Escrow API key | `TRUSTLESS_WORK_API_KEY` in secrets provider | Finance Owner |

---

## 6. Nonproduction recovery drill

The drill is run **at least monthly** in the staging environment and after any
change to a recovery-relevant system (backup config, contract IDs, RPC
provider list, SMTP provider). It is automated by
[`scripts/recovery-drill.sh`](../scripts/recovery-drill.sh) and scheduled by
[`.github/workflows/recovery-drill.yml`](../.github/workflows/recovery-drill.yml).

**Drill target.** Prove that after a simulated multi-component outage, **core
reads recover within 35 min** and **booking lookup and payment reconciliation
recover within 45 min** of detection. The drill records the actual times;
a PASS requires every step to meet its target.

### 6.1 Prerequisites

- PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`)
- `redis-cli` reachable from the drill host
- `curl`, `jq`, `openssl`
- Staging secrets for the **automated drill** (see
  [`infra/environments/staging/secrets.reference.md`](../infra/environments/staging/secrets.reference.md)):
  `PROD_DB_HOST`, `PROD_DB_USER`, `PROD_DB_PASSWORD`,
  `VERIFY_DB_HOST`, `VERIFY_DB_USER`, `VERIFY_DB_PASSWORD`,
  `STAGING_API_URL`, `REDIS_URL`, `ADMIN_JWT`
- For the **Finance Owner's manual cross-check** in §6.7 step 3:
  `TRUSTLESS_WORK_API_KEY` and access to the Trustless Work staging
  dashboard. `STELLAR_RPC_URL` and `BOOKING_CONTRACT_ID` are required once
  §7.2 risk #2 (fresh on-chain lookup) is closed.
- A witness from a second owner role for the dual-approval steps
- An open incident record (use the incident review template) titled
  "Recovery drill <YYYY-MM-DD>"

### 6.2 Database restoration (target RTO 30 min)

Run by the DBA (A) and On-Call SRE (R). The drill restores the staging backup
into an isolated verification database — never into the staging primary.

```bash
# Orchestrated by scripts/recovery-drill.sh — Phase 1
bash scripts/recovery-drill.sh --phase db-restore
```

What the script does (manual equivalent in
[`docs/backup-restore-verification.md`](./backup-restore-verification.md)):

1. `pg_dump` the staging primary to a timestamped dump file.
2. `CREATE DATABASE rentars_drill_<ts>` on the verification host.
3. `pg_restore` into the verification DB; record start/end time as `RTO_DB`.
4. Validate critical tables: `users`, `properties`, `bookings`, `payments`,
   `notifications`, `audit_logs`, `sync_log`.
5. Validate extensions: `uuid-ossp`, `pgcrypto`, `pgtrgm`.
6. Validate RLS policies exist on `public` schema.
7. Tear down the verification DB.

**Pass.** `RTO_DB <= 1800s` and all validations succeed. **Fail.** Any
validation fails or the restore errors out — record the gap in §7.

### 6.3 Cache rebuild (target RTO 5 min)

Run by the Backend On-Call (A) and On-Call SRE (R).

```bash
bash scripts/recovery-drill.sh --phase cache-rebuild
```

1. Flush the staging Redis DB: `redis-cli -h $REDIS_HOST FLUSHDB`.
2. Warm the hot keys by issuing the top read paths against the staging API:
   - `GET /properties?limit=20` (property list cache)
   - `GET /properties/<id>` for the top 10 properties by view count (detail cache)
   - `GET /properties/search?q=<term>` for the top 3 search terms
3. Record the time from `FLUSHDB` to the first cache-hit response as `RTO_CACHE`.
4. Verify `redis-cli DBSIZE > 0` and the cache hit rate on the next 100 requests
   is > 50%.

**Pass.** `RTO_CACHE <= 300s` and hit rate > 50%. **Fail.** Hit rate < 50% —
investigate TTLs or missing warm-up endpoints.

### 6.4 Sync resume (target RTO 10 min)

Run by the Backend On-Call (A) and Contracts Lead (C).

```bash
bash scripts/recovery-drill.sh --phase sync-resume
```

1. Invoke the sync-all endpoints at their intended mount path:
   ```bash
   curl -X POST "$STAGING_API_URL/api/v1/sync/properties" \
     -H "Authorization: Bearer $ADMIN_JWT"
   curl -X POST "$STAGING_API_URL/api/v1/sync/bookings" \
     -H "Authorization: Bearer $ADMIN_JWT"
   ```
   The handlers exist in `apps/backend/src/controllers/sync.controller.ts`
   (`syncAllPropertiesHandler`, `syncAllBookingsHandler`) and are wired in
   `apps/backend/src/routes/sync.routes.ts`. If the routes are not yet mounted
   in `routes/index.ts`, both calls return 404 and the drill records the gap
   in §7.2 (risk #1) — the drill FAILS the phase, by design.
2. Poll `sync_log` for freshness: the most recent booking sync entry should be
   < 120 s old. A direct ledger-lag check would require `stellar-cli` in the
   drill runner; `sync_log` age is the freshness proxy and the lag-check gap
   is recorded in §7.2 (risk #2).
3. Confirm no new `status='failed'` rows were written during catch-up.

**Pass.** `RTO_SYNC <= 600s`, sync routes respond 200/202, and the most recent
booking sync entry is < 120 s old. **Fail.** 404 on the sync routes (not
mounted) or sync not converging — record the gap in §7.2.

### 6.5 Core reads verification

Run by the On-Call SRE (R). Proves the read path serves traffic after recovery.

```bash
bash scripts/recovery-drill.sh --phase core-reads
```

1. `GET /health/deep` returns `database: connected`, `redis: connected`,
   `stellar: connected`.
2. `GET /properties?limit=20` returns 200 in < 500 ms p99.
3. `GET /properties/<id>` returns 200 for the top 10 properties.
4. `GET /properties/search?q=<term>` returns 200 for the top 3 terms.
5. Authenticated read: `GET /api/v1/bookings` (as a test tenant) returns 200.

**Pass.** All return 200 within latency targets. **Fail.** Any 5xx or
latency over target — record the failing path in §7.

### 6.6 Booking lookup verification

Run by the Backend On-Call (A) and Finance Owner (C). Proves that a booking
created before the outage can be found and its state is consistent across the
admin API, the database, and the last on-chain sync.

```bash
bash scripts/recovery-drill.sh --phase booking-lookup --sample-size 20
```

1. Pull the sample from the admin API: `GET /api/v1/admin/bookings?limit=20`
   returns `{ data: [...], meta }` with rows `id, property_id, user_id,
   status, check_in, check_out, total_price, created_at`.
2. Pull the same sample's full rows from the DB (the admin API does not return
   `on_chain_id` or `escrow_id`):
   ```sql
   SELECT id, property_id, user_id, status, on_chain_id, escrow_id
   FROM bookings ORDER BY created_at DESC LIMIT 20;
   ```
3. For each booking, verify four things agree:
   - **Admin API vs DB**: the status returned by `GET /api/v1/admin/bookings`
     for the booking's `id` matches the DB `status`.
   - **Tenant exists**: the booking's `user_id` is present in `users`.
   - **Host exists**: `properties.owner_id` for the booking's `property_id`
     is present in `users` (join `properties` → `users` on `owner_id`).
   - **On-chain agreement**: the last `sync_log` row for the booking's
     `on_chain_id` has `status = 'success'` and a status matching the DB
     `status`, OR the booking is quarantined
     (`status = 'escrow_reconcile_failed'`), OR the booking has no
     `on_chain_id` (off-chain-only). A fresh on-chain lookup (vs. last
     synced) requires the sync route to be mounted — see §7.2 risk #2.
4. Record the elapsed time as `RTO_BOOKING_LOOKUP`.

**Pass.** All four checks agree for 20/20 bookings within 45 min of detection.
**Fail.** Any disagreement — record the booking ID and the mismatch in §7.2
and follow §4.8 for that booking.

> **Why the DB joins and not `GET /api/v1/bookings/:id`.** That endpoint is
> user-scoped (`authenticate` middleware checks ownership), so an admin JWT
> would 403 on a booking owned by another user. The admin bookings list and
> direct DB reads are the correct read paths for a cross-user consistency
> check.

### 6.7 Payment reconciliation verification

Run by the Finance Owner (A) and Backend On-Call (R). Proves escrow state
matches the booking state.

```bash
bash scripts/recovery-drill.sh --phase reconciliation
```

1. Trigger the reconcile job at its intended path:
   ```bash
   curl -X POST "$STAGING_API_URL/api/v1/sync/reconcile" \
     -H "Authorization: Bearer $ADMIN_JWT"
   ```
   `reconcileAllPendingEscrows` exists in `sync.service.ts` but is **not yet
   wired to an HTTP route**. If the call 404s, the drill records the gap in
   §7.2 (risk #1) and falls back to the DB-only discrepancy count below.
2. Count discrepancy classes directly from the DB (this is the fallback that
   runs whether or not the trigger endpoint exists):
   ```sql
   -- A. Completed/Cancelled bookings with no escrow_id (orphaned)
   SELECT COUNT(*) FROM bookings
     WHERE status IN ('Completed','Cancelled')
       AND (escrow_id IS NULL OR escrow_id = '');
   -- B. Bookings quarantined in escrow_reconcile_failed
   SELECT COUNT(*) FROM bookings WHERE status = 'escrow_reconcile_failed';
   -- C. Pending/Confirmed bookings whose escrow never locked
   SELECT COUNT(*) FROM bookings
     WHERE status IN ('Pending','Confirmed')
       AND (escrow_id IS NULL OR escrow_id = '');
   ```
3. For each `Completed` booking with an escrow, a Finance Owner (A) confirms
   against the Trustless Work dashboard that the escrow is in a `released`
   state. This manual cross-check is required for the production drill and is
   recorded in the drill report's sign-off table (§6.8).
4. Record the elapsed time as `RTO_RECONCILE` and the discrepancy count.

**Pass.** `RTO_RECONCILE <= 45 min from detection` and zero discrepancies
(across all three classes), and the Finance Owner confirms escrow states for
the `Completed` sample. **Fail.** Any discrepancy — follow §4.8 for each, and
record the gap in §7.2.

> **On the missing trigger endpoint.** Until `reconcileAllPendingEscrows` is
> exposed (§7.2 risk #1), the drill's reconciliation phase verifies **state**
> (no orphaned or quarantined bookings) but cannot verify a **fresh** reconcile
> run. The Finance Owner's manual Trustless Work cross-check (step 3) is the
> authoritative verification in the meantime.

### 6.8 Drill report & sign-off

The drill script writes a JSON report to `recovery_drill_<ts>.json` and a
human-readable log to `recovery_drill_<ts>.log`. Both are uploaded as CI
artifacts by the workflow. The Incident Commander fills in the sign-off
table:

| Step | Target | Actual | Pass/Fail | Owner (A) |
|---|---|---|---|---|
| 6.2 DB restore | ≤ 30 min | __ | __ | DBA |
| 6.3 Cache rebuild | ≤ 5 min | __ | __ | Backend On-Call |
| 6.4 Sync resume | ≤ 10 min | __ | __ | Backend On-Call |
| 6.5 Core reads | 100% 200, p99 < 500 ms | __ | __ | On-Call SRE |
| 6.6 Booking lookup | 20/20 agree, ≤ 45 min | __ | __ | Backend On-Call |
| 6.7 Reconciliation | 0 discrepancies, ≤ 45 min | __ | __ | Finance Owner |
| **Aggregate** | Reads ≤ 35 min, lookup+recon ≤ 45 min | __ | __ | Incident Commander |

A PASS requires every row green. Any red row produces a follow-up risk in §7
with an owner and a due date before the drill is closed.

---

## 7. Retrospective & follow-up risks

The retrospective is held within 72 hours of every drill, led by the Incident
Commander, with all §3 owners present. Use the
[`docs/INCIDENT_REVIEW_TEMPLATE.md`](./INCIDENT_REVIEW_TEMPLATE.md) sections
for impact, timeline, detection, response, and root cause.

### 7.1 What went well / what could have gone better

Capture both. Be specific — "cache warm-up was fast" is less useful than
"cache hit rate hit 70% within 90 s of FLUSHDB because the warm-up script
pre-fetches the top 10 properties".

### 7.2 Follow-up risks register

Every gap, slow step, or unmet target from §6.8 becomes a row below. **A row
without an owner and a due date is not a valid entry.** The Incident Commander
is responsible for closing each row before the next drill.

The first two rows below are **pre-identified gaps** discovered while writing
this runbook and the drill script (the sync handlers exist but are not mounted,
and the reconcile trigger is not exposed). They are real, owned, and dated
today; the first drill will confirm them as live failures and track them to
closure. Retrospectives append further rows in the same format.

| # | Risk / gap | Source (step) | Owner (A) | Due date | Tracking link | Status |
|---|---|---|---|---|---|---|
| 1 | `sync.routes.ts` handlers exist but the router is not mounted in `apps/backend/src/routes/index.ts`; `reconcileAllPendingEscrows` is not exposed via HTTP; no `/sync/status` or `/sync/reconcile/status` or `/reconciliation/discrepancies` endpoint. Drill §6.4 and §6.7 cannot pass until routes are mounted and reconcile wired. | §6.4, §6.7 | Backend On-Call | 2026-11-15 | (issue link) | Open |
| 2 | Drill measures sync freshness via `sync_log` age, not direct ledger lag; on-chain lookup uses the last synced status rather than a fresh contract read. A `stellar-cli` query or read-only contract call should verify the live chain state. | §6.4, §6.6 | Contracts Lead | 2026-12-01 | (issue link) | Open |

Retrospective-added rows are appended below the pre-identified rows, never
above them, so the history of pre-identified gaps stays auditable.

### 7.3 Drill history

| Date | Env | Commander | Result | Aggregate reads | Lookup+recon | Report |
|---|---|---|---|---|---|---|
| YYYY-MM-DD | staging | @handle | PASS/FAIL | __ min | __ min | `recovery_drill_*.json` |

After each drill, append a row. The history is the evidence reviewed at launch
readiness (see [`LAUNCH_READINESS.md`](../LAUNCH_READINESS.md)).

---

## 8. Appendices

### 8.1 Quick reference: which runbook for which symptom

| Symptom | Go to |
|---|---|
| Database errors in `/health/deep` | §4.1 |
| Images 404 at scale | §4.2 |
| Cache miss rate spike / Redis down | §4.3 |
| Contract invocation failures | §4.4 |
| Sync lag > 30 ledgers | §4.5 / §6.4 |
| Email notifications not arriving | §4.6 |
| Frontend 5xx spike after release | §4.7 |
| Bookings marked Completed but escrow not released | §4.8 / §6.7 |

### 8.2 Quick reference: dual-approval actions

| Action | A | Approver (separate person) |
|---|---|---|
| Restore DB to production primary | DBA | Infra Owner or Backend On-Call |
| Switch contract IDs | Contracts Lead | Backend On-Call or Infra Owner |
| Rotate `JWT_SECRET` | Infra Owner | On-Call SRE (see [`docs/admin-runbooks.md`](./admin-runbooks.md) Runbook 6) |
| Manual USDC refund | Finance Owner | Second `admin` or `finance` (see [`docs/admin-runbooks.md`](./admin-runbooks.md) Runbook 5) |
| Lift booking freeze after §4.8 | Finance Owner | Backend On-Call |

### 8.3 Glossary

| Term | Definition |
|---|---|
| RTO | Recovery Time Objective — max time to restore after detection |
| RPO | Recovery Point Objective — max acceptable data loss |
| PITR | Point-in-Time Recovery (Postgres / Supabase feature) |
| Quarantined booking | Booking in `escrow_reconcile_failed` after exhausting retries |
| Sync lag | Ledgers between the chain head and the last row in `sync_log` |
| Manifest | Per-release record of commit, image, migration, contract IDs, ABI hashes |
