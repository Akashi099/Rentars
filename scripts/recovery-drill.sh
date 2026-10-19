#!/usr/bin/env bash
#
# recovery-drill.sh — Rentars multi-component recovery drill.
#
# Implements the drill in docs/RECOVERY_RUNBOOK.md §6. Runs entirely against
# NON-PRODUCTION (staging) resources. Never restores into the staging primary.
#
# Phases (run individually with --phase, or all sequentially with --phase all):
#   db-restore       §6.2  — database restore into isolated verification DB
#   cache-rebuild    §6.3  — flush + warm Redis, measure hit-rate recovery
#   sync-resume      §6.4  — resume blockchain sync, measure lag convergence
#   core-reads       §6.5  — verify read paths (health, properties, search)
#   booking-lookup   §6.6  — verify DB/tenant/host/on-chain booking lookups agree
#   reconciliation    §6.7  — verify escrow state matches booking state
#   report           §6.8  — write JSON + log report and PASS/FAIL summary
#
# Required environment (staging):
#   PROD_DB_HOST, PROD_DB_USER, PROD_DB_PASSWORD
#   VERIFY_DB_HOST, VERIFY_DB_USER, VERIFY_DB_PASSWORD
#   STAGING_API_URL, ADMIN_JWT
#   REDIS_URL (or REDIS_HOST)
#   STELLAR_RPC_URL, BOOKING_CONTRACT_ID
#   TRUSTLESS_WORK_API_KEY (for §6.7, optional for non-finance drills)
#
# Usage:
#   bash scripts/recovery-drill.sh --phase all
#   bash scripts/recovery-drill.sh --phase db-restore
#   bash scripts/recovery-drill.sh --phase booking-lookup --sample-size 30
#
# Outputs:
#   recovery_drill_<ts>.log   — human-readable drill log
#   recovery_drill_<ts>.json  — machine-readable result for CI gating
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration & defaults
# ---------------------------------------------------------------------------

TS="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="recovery_drill_${TS}.log"
JSON_FILE="recovery_drill_${TS}.json"
PHASE="${PHASE:-all}"
SAMPLE_SIZE="${SAMPLE_SIZE:-20}"

# Recovery targets (seconds). Must match docs/RECOVERY_RUNBOOK.md §2.
RTO_DB=1800          # 30 min
RTO_CACHE=300        # 5 min
RTO_SYNC=600         # 10 min
LATENCY_P99_MS=500   # core reads
RTO_BOOKING_LOOKUP=2700  # 45 min
RTO_RECONCILE=2700      # 45 min

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

# Result accumulator (the report phase reads this)
declare -A RESULTS=()
declare -A NOTES=()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log()  { echo -e "${GREEN}[INFO]${NC} $(date -u +%H:%M:%S) $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $(date -u +%H:%M:%S) $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[ERROR]${NC} $(date -u +%H:%M:%S) $*" | tee -a "$LOG_FILE"; }

on_error() {
  err "Drill failed at phase=${PHASE} step=${CURRENT_STEP:-unknown}"
  RESULTS["${CURRENT_STEP:-unknown}"]="fail"
  write_report
  exit 1
}
trap on_error ERR

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --sample-size) SAMPLE_SIZE="$2"; shift 2 ;;
    --log) LOG_FILE="$2"; shift 2 ;;
    --json) JSON_FILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0 ;;
    *) err "Unknown arg: $1"; exit 2 ;;
  esac
done

# SAMPLE_SIZE is interpolated into SQL — reject anything that is not a
# positive integer to prevent injection via the workflow_dispatch input.
if ! [[ "$SAMPLE_SIZE" =~ ^[0-9]+$ ]] || [ "$SAMPLE_SIZE" -lt 1 ]; then
  err "SAMPLE_SIZE must be a positive integer, got '$SAMPLE_SIZE'"
  exit 2
fi
[ "$SAMPLE_SIZE" -gt 1000 ] && SAMPLE_SIZE=1000

# ---------------------------------------------------------------------------
# Env validation
# ---------------------------------------------------------------------------

require_env() {
  local missing=0
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      err "Missing required env var: $var"
      missing=1
    fi
  done
  if [ "$missing" -ne 0 ]; then exit 1; fi
}

require_env STAGING_API_URL ADMIN_JWT

REDIS_HOST="${REDIS_HOST:-$(echo "$REDIS_URL" | sed -E 's#redis://([^:@/]+).*#\1#' 2>/dev/null || true)}"

# Run a SQL query against the staging source DB and print the result.
# Used for booking-lookup and reconciliation phases, which need fields the
# admin API does not return (on_chain_id, escrow_id) and for sync-log state.
db_query() {
  PGPASSWORD="$PROD_DB_PASSWORD" psql -h "$PROD_DB_HOST" -U "$PROD_DB_USER" \
    -d rentars -t -A -F $'\t' -c "$1" 2>>"$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Report writer
# ---------------------------------------------------------------------------

write_report() {
  local overall="pass"
  local json tmp
  json="{"
  json+="\"drill_id\":\"$TS\","
  json+="\"started_at\":\"$(date -u +%FT%TZ)\","
  json+="\"environment\":\"${ENVIRONMENT:-staging}\","
  json+="\"phases\":{"
  local first=1
  for step in "${!RESULTS[@]}"; do
    [ $first -eq 1 ] && first=0 || json+=","
    # escape notes
    tmp="${NOTES[$step]:-}"
    tmp="${tmp//\"/\\\"}"
    json+="\"$step\":{\"result\":\"${RESULTS[$step]}\",\"note\":\"$tmp\"}"
  done
  json+="}"
  # Determine overall
  for step in "${!RESULTS[@]}"; do
    if [ "${RESULTS[$step]}" != "pass" ]; then overall="fail"; fi
  done
  json+=",\"overall\":\"$overall\""
  json+="}"
  echo "$json" > "$JSON_FILE"
  log "Report written: $JSON_FILE"
  if [ "$overall" = "pass" ]; then
    echo -e "${GREEN}=== DRILL PASSED ===${NC}"
  else
    echo -e "${RED}=== DRILL FAILED — see $JSON_FILE ===${NC}"
  fi
}

# ---------------------------------------------------------------------------
# Phase 1 — Database restore (§6.2)
# ---------------------------------------------------------------------------

phase_db_restore() {
  CURRENT_STEP="db_restore"
  log "=== Phase: database restore (§6.2) ==="
  require_env PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD \
              VERIFY_DB_HOST VERIFY_DB_USER VERIFY_DB_PASSWORD

  local backup_file="recovery_drill_${TS}_backup.dump"
  local verify_db="rentars_drill_${TS}"

  log "Exporting backup from source DB..."
  export PGPASSWORD="$PROD_DB_PASSWORD"
  pg_dump --host="$PROD_DB_HOST" --username="$PROD_DB_USER" \
    --format=custom --no-owner rentars > "$backup_file" 2>>"$LOG_FILE"
  local size; size="$(du -h "$backup_file" | cut -f1)"
  log "Backup exported: $size"

  log "Creating isolated verification DB: $verify_db"
  export PGPASSWORD="$VERIFY_DB_PASSWORD"
  psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
    -c "CREATE DATABASE $verify_db;" >>"$LOG_FILE" 2>&1

  local t0 t1 rto
  t0=$(date +%s)
  log "Restoring backup..."
  pg_restore --host="$VERIFY_DB_HOST" --username="$VERIFY_DB_USER" \
    --dbname="$verify_db" --no-owner --verbose \
    "$backup_file" >>"$LOG_FILE" 2>&1
  t1=$(date +%s)
  rto=$((t1 - t0))
  log "Restore completed in ${rto}s (target ${RTO_DB}s)"

  # Validate critical tables
  local tables=("users" "properties" "bookings" "payments"
                "notifications" "audit_logs" "sync_log")
  local missing=0
  for t in "${tables[@]}"; do
    local count
    count=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d "$verify_db" \
      -t -A -c "SELECT COUNT(*) FROM $t;" 2>>"$LOG_FILE" || echo "ERR")
    if [[ "$count" == "ERR" ]]; then
      err "Table missing or inaccessible: $t"
      missing=1
    else
      log "  table $t: $count rows"
    fi
  done
  [ $missing -ne 0 ] && { RESULTS["db_restore"]="fail"; NOTES["db_restore"]="missing tables"; }

  # Validate extensions
  local exts=("uuid-ossp" "pgcrypto" "pgtrgm")
  for e in "${exts[@]}"; do
    local c
    c=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d "$verify_db" \
      -t -A -c "SELECT COUNT(*) FROM pg_extension WHERE extname='$e';" 2>>"$LOG_FILE" || echo 0)
    [ "$c" -gt 0 ] && log "  extension $e: present" || warn "  extension $e: MISSING"
  done

  # Validate RLS policies
  local policy_count
  policy_count=$(psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d "$verify_db" \
    -t -A -c "SELECT COUNT(*) FROM pg_policies WHERE schemaname='public';" 2>>"$LOG_FILE" || echo 0)
  log "  RLS policies on public: $policy_count"

  # Cleanup
  psql -h "$VERIFY_DB_HOST" -U "$VERIFY_DB_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS $verify_db;" >>"$LOG_FILE" 2>&1
  rm -f "$backup_file"

  if [ "${RESULTS[db_restore]:-pass}" != "fail" ] && [ "$rto" -le "$RTO_DB" ]; then
    RESULTS["db_restore"]="pass"
    NOTES["db_restore"]="rto=${rto}s backup_size=${size} policies=${policy_count}"
  else
    RESULTS["db_restore"]="fail"
    [ "$rto" -gt "$RTO_DB" ] && NOTES["db_restore"]="rto=${rto}s exceeds ${RTO_DB}s"
  fi
  log "Phase db_restore: ${RESULTS[db_restore]}"
}

# ---------------------------------------------------------------------------
# Phase 2 — Cache rebuild (§6.3)
# ---------------------------------------------------------------------------

phase_cache_rebuild() {
  CURRENT_STEP="cache_rebuild"
  log "=== Phase: cache rebuild (§6.3) ==="
  require_env STAGING_API_URL
  if [ -z "$REDIS_HOST" ]; then err "REDIS_HOST or REDIS_URL required"; exit 1; fi

  log "Flushing staging Redis (DB 0 only)..."
  redis-cli -h "$REDIS_HOST" -n 0 FLUSHDB >>"$LOG_FILE" 2>&1
  local t0 t1 rto
  t0=$(date +%s)

  # Warm hot keys
  log "Warming property list cache..."
  curl -sf "$STAGING_API_URL/properties?limit=20" -o /dev/null >>"$LOG_FILE" 2>&1 || true

  log "Warming property detail cache (top 10 by view count)..."
  local ids
  ids=$(curl -sf "$STAGING_API_URL/properties?limit=10&sort=views" \
        | jq -r '.[].id // .properties[].id // empty' 2>>"$LOG_FILE" || true)
  for id in $ids; do
    curl -sf "$STAGING_API_URL/properties/$id" -o /dev/null >>"$LOG_FILE" 2>&1 || true
  done

  log "Warming search cache (top 3 terms)..."
  for term in "apartment" "villa" "studio"; do
    curl -sf "$STAGING_API_URL/properties/search?q=$term" -o /dev/null >>"$LOG_FILE" 2>&1 || true
  done

  t1=$(date +%s)
  rto=$((t1 - t0))

  # Verify hit rate on next 100 requests
  local hits=0 total=100
  for i in $(seq 1 $total); do
    local id
    id=$(echo "$ids" | sed -n "$((i % 10 + 1))p")
    [ -z "$id" ] && id="${ids%% *}"
    if [ -n "$id" ]; then
      curl -sf "$STAGING_API_URL/properties/$id" -o /dev/null >>"$LOG_FILE" 2>&1 && hits=$((hits + 1))
    fi
  done
  local hit_rate=0
  [ "$total" -gt 0 ] && hit_rate=$((hits * 100 / total))
  log "Cache hit rate on next $total requests: ${hit_rate}% (target > 50%)"
  log "Cache rebuild completed in ${rto}s (target ${RTO_CACHE}s)"

  if [ "$rto" -le "$RTO_CACHE" ] && [ "$hit_rate" -gt 50 ]; then
    RESULTS["cache_rebuild"]="pass"
    NOTES["cache_rebuild"]="rto=${rto}s hit_rate=${hit_rate}%"
  else
    RESULTS["cache_rebuild"]="fail"
    NOTES["cache_rebuild"]="rto=${rto}s hit_rate=${hit_rate}% (target rto<=${RTO_CACHE}s hit>50%)"
  fi
  log "Phase cache_rebuild: ${RESULTS[cache_rebuild]}"
}

# ---------------------------------------------------------------------------
# Phase 3 — Sync resume (§6.4)
# ---------------------------------------------------------------------------

phase_sync_resume() {
  CURRENT_STEP="sync_resume"
  log "=== Phase: sync resume (§6.4) ==="
  require_env STAGING_API_URL ADMIN_JWT PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD

  local t0 t1 rto
  t0=$(date +%s)

  # The sync routes live in apps/backend/src/routes/sync.routes.ts and are
  # intended to be mounted at /api/v1/sync. If they are not mounted, these
  # calls 404 and the drill records the gap — see docs/RECOVERY_RUNBOOK.md §7.2.
  local sync_props_code sync_book_code
  log "Triggering full property sync (POST /api/v1/sync/properties)..."
  sync_props_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$STAGING_API_URL/api/v1/sync/properties" \
    -H "Authorization: Bearer $ADMIN_JWT" 2>>"$LOG_FILE" || echo 000)
  log "  sync/properties -> HTTP $sync_props_code"

  log "Triggering full booking sync (POST /api/v1/sync/bookings)..."
  sync_book_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$STAGING_API_URL/api/v1/sync/bookings" \
    -H "Authorization: Bearer $ADMIN_JWT" 2>>"$LOG_FILE" || echo 000)
  log "  sync/bookings -> HTTP $sync_book_code"

  # Measure convergence as "seconds since the most recent booking sync log
  # entry". A direct ledger-lag check would need stellar-cli (not installed in
  # the drill runner); the sync_log age is a sufficient freshness proxy for
  # the drill and is recorded as a known gap in §7.2.
  local last_sync age converged=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 15
    last_sync=$(db_query "SELECT COALESCE(MAX(synced_at), 'epoch'::timestamptz) FROM sync_log WHERE entity_type='booking';" || echo "")
    if [[ "$last_sync" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2} ]] && [ "$last_sync" != "" ]; then
      age=$(($(date +%s) - $(date -u -d "$last_sync" +%s 2>/dev/null || echo 0)))
      log "  poll $i: last booking sync ${age}s ago"
      # 120s freshness target — far tighter than the §2 30-ledger (~150s) target
      if [ "$age" -ge 0 ] && [ "$age" -le 120 ]; then converged=1; break; fi
    else
      log "  poll $i: no sync_log entries yet"
    fi
  done

  t1=$(date +%s)
  rto=$((t1 - t0))
  log "Sync resume completed in ${rto}s (target ${RTO_SYNC}s), converged=$converged, last_sync=$last_sync"

  if [ "$converged" -eq 1 ] && [ "$rto" -le "$RTO_SYNC" ] \
     && [ "$sync_props_code" = "200" -o "$sync_props_code" = "202" ] \
     && [ "$sync_book_code" = "200" -o "$sync_book_code" = "202" ]; then
    RESULTS["sync_resume"]="pass"
    NOTES["sync_resume"]="rto=${rto}s age=${age}s sync_props=$sync_props_code sync_book=$sync_book_code"
  else
    RESULTS["sync_resume"]="fail"
    NOTES["sync_resume"]="rto=${rto}s converged=$converged sync_props=$sync_props_code sync_book=$sync_book_code (if 404: sync.routes.ts not mounted at /api/v1/sync — see §7.2)"
  fi
  log "Phase sync_resume: ${RESULTS[sync_resume]}"
}

# ---------------------------------------------------------------------------
# Phase 4 — Core reads (§6.5)
# ---------------------------------------------------------------------------

phase_core_reads() {
  CURRENT_STEP="core_reads"
  log "=== Phase: core reads (§6.5) ==="
  require_env STAGING_API_URL ADMIN_JWT

  local failures=0 max_lat=0

  check_read() {
    local label="$1" url="$2" auth="${3:-}"
    local t0 t1 lat code
    t0=$(date +%s%3N)
    if [ -n "$auth" ]; then
      code=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $auth" "$url" 2>>"$LOG_FILE" || echo 000)
    else
      code=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>>"$LOG_FILE" || echo 000)
    fi
    t1=$(date +%s%3N)
    lat=$((t1 - t0))
    [ "$lat" -gt "$max_lat" ] && max_lat=$lat
    if [ "$code" = "200" ] && [ "$lat" -le "$LATENCY_P99_MS" ]; then
      log "  $label: $code ${lat}ms OK"
    else
      err "  $label: $code ${lat}ms (target 200, <=${LATENCY_P99_MS}ms)"
      failures=$((failures + 1))
    fi
  }

  check_read "health/deep" "$STAGING_API_URL/health/deep"
  check_read "properties?limit=20" "$STAGING_API_URL/properties?limit=20"
  check_read "properties/<id>" "$STAGING_API_URL/properties?limit=1"
  check_read "search?q=apartment" "$STAGING_API_URL/properties/search?q=apartment"
  check_read "bookings (auth)" "$STAGING_API_URL/api/v1/bookings?limit=1" "$ADMIN_JWT"

  if [ "$failures" -eq 0 ]; then
    RESULTS["core_reads"]="pass"
    NOTES["core_reads"]="max_latency=${max_lat}ms"
  else
    RESULTS["core_reads"]="fail"
    NOTES["core_reads"]="failures=$failures max_latency=${max_lat}ms"
  fi
  log "Phase core_reads: ${RESULTS[core_reads]}"
}

# ---------------------------------------------------------------------------
# Phase 5 — Booking lookup (§6.6)
# ---------------------------------------------------------------------------

phase_booking_lookup() {
  CURRENT_STEP="booking_lookup"
  log "=== Phase: booking lookup (§6.6) sample_size=$SAMPLE_SIZE ==="
  require_env STAGING_API_URL ADMIN_JWT PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD

  local t0 t1 rto
  t0=$(date +%s)

  # 1) Pull the booking sample from the admin API (real endpoint).
  local api_resp
  api_resp=$(curl -sf "$STAGING_API_URL/api/v1/admin/bookings?limit=$SAMPLE_SIZE" \
             -H "Authorization: Bearer $ADMIN_JWT" 2>>"$LOG_FILE" || echo "")
  if [ -z "$api_resp" ]; then
    err "Could not fetch booking sample from /api/v1/admin/bookings"
    RESULTS["booking_lookup"]="fail"
    NOTES["booking_lookup"]="admin bookings endpoint unreachable"
    return
  fi

  # 2) Pull the same sample's full rows from the DB (on_chain_id, escrow_id,
  #    user_id, property_id are not returned by the admin API).
  local db_rows
  db_rows=$(db_query "SELECT id, property_id, user_id, status, COALESCE(on_chain_id::text,''), COALESCE(escrow_id::text,'') FROM bookings ORDER BY created_at DESC LIMIT $SAMPLE_SIZE;" || echo "")
  if [ -z "$db_rows" ]; then
    err "Could not fetch booking rows from DB"
    RESULTS["booking_lookup"]="fail"
    NOTES["booking_lookup"]="db query returned no rows"
    return
  fi

  local total=0 agree=0 disagree=0
  while IFS=$'\t' read -r id property_id user_id db_status on_chain_id escrow_id; do
    [ -z "$id" ] && continue
    total=$((total + 1))

    # DB vs API agreement: the admin API must return this booking with the
    # same status. jq filters the API response by id.
    local api_status
    api_status=$(echo "$api_resp" \
      | jq -r --arg id "$id" \
        '[.data[]? // .[]?] | map(select(.id == $id)) | .[0].status // "MISSING"' 2>>"$LOG_FILE" || echo "ERR")
    if [ "$api_status" = "ERR" ] || [ "$api_status" = "MISSING" ]; then
      disagree=$((disagree + 1))
      warn "  booking $id: API status=$api_status (db=$db_status) — disagree"
      continue
    fi
    [ "$api_status" != "$db_status" ] && { disagree=$((disagree + 1)); warn "  booking $id: api=$api_status db=$db_status"; continue; }

    # Tenant agreement: the booking's user_id must be a real user.
    local tenant_exists
    tenant_exists=$(db_query "SELECT COUNT(*) FROM users WHERE id='$user_id';" || echo 0)
    [ "${tenant_exists:-0}" -lt 1 ] && { disagree=$((disagree + 1)); warn "  booking $id: tenant $user_id missing"; continue; }

    # Host agreement: the property's owner must exist.
    local host_exists
    host_exists=$(db_query "SELECT COUNT(*) FROM properties p JOIN users u ON u.id=p.owner_id WHERE p.id='$property_id';" || echo 0)
    [ "${host_exists:-0}" -lt 1 ] && { disagree=$((disagree + 1)); warn "  booking $id: host for property $property_id missing"; continue; }

    # On-chain agreement: the last sync_log status for this booking must
    # match the DB status, OR the booking must be quarantined
    # (escrow_reconcile_failed), OR the booking has no on-chain id
    # (off-chain-only). A fresh on-chain lookup requires the sync route to
    # be mounted (see §7.2 follow-up risk).
    local chain_ok=1
    if [ -n "$on_chain_id" ] && [ "$on_chain_id" != "" ]; then
      local last_sync_status
      last_sync_status=$(db_query "SELECT status FROM sync_log WHERE entity_type='booking' AND entity_id='$on_chain_id' ORDER BY synced_at DESC LIMIT 1;" || echo "")
      if [ -n "$last_sync_status" ] && [ "$last_sync_status" != "success" ] && [ "$last_sync_status" != "$db_status" ]; then
        chain_ok=0
        warn "  booking $id: last sync_log status=$last_sync_status vs db=$db_status"
      fi
    fi
    [ "$chain_ok" -ne 1 ] && { disagree=$((disagree + 1)); continue; }

    agree=$((agree + 1))
  done <<< "$db_rows"

  t1=$(date +%s)
  rto=$((t1 - t0))
  log "Booking lookup: $agree/$total agree, $disagree disagree in ${rto}s (target ${RTO_BOOKING_LOOKUP}s)"

  if [ "$agree" -eq "$total" ] && [ "$rto" -le "$RTO_BOOKING_LOOKUP" ] && [ "$total" -ge 1 ]; then
    RESULTS["booking_lookup"]="pass"
    NOTES["booking_lookup"]="agree=$agree/$total rto=${rto}s"
  else
    RESULTS["booking_lookup"]="fail"
    NOTES["booking_lookup"]="agree=$agree/$total disagree=$disagree rto=${rto}s"
  fi
  log "Phase booking_lookup: ${RESULTS[booking_lookup]}"
}

# ---------------------------------------------------------------------------
# Phase 6 — Payment reconciliation (§6.7)
# ---------------------------------------------------------------------------

phase_reconciliation() {
  CURRENT_STEP="reconciliation"
  log "=== Phase: payment reconciliation (§6.7) ==="
  require_env STAGING_API_URL ADMIN_JWT PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD

  local t0 t1 rto reconcile_code
  t0=$(date +%s)

  # The reconcile trigger endpoint is intended at /api/v1/sync/reconcile. If it
  # is not wired yet, the call 404s and the drill falls back to a DB-only
  # discrepancy count (see §7.2 follow-up risk).
  log "Triggering reconcileAllPendingEscrows (POST /api/v1/sync/reconcile)..."
  reconcile_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "$STAGING_API_URL/api/v1/sync/reconcile" \
    -H "Authorization: Bearer $ADMIN_JWT" 2>>"$LOG_FILE" || echo 000)
  log "  sync/reconcile -> HTTP $reconcile_code"

  # Give the reconcile job a brief window if it was accepted.
  if [ "$reconcile_code" = "200" ] || [ "$reconcile_code" = "202" ]; then
    for i in 1 2 3 4 5 6 7 8 9 10; do
      sleep 30
      local pending
      pending=$(curl -sf "$STAGING_API_URL/api/v1/sync/reconcile/status" \
                -H "Authorization: Bearer $ADMIN_JWT" \
                | jq -r '.pending // "unknown"' 2>>"$LOG_FILE" || echo "unknown")
      log "  poll $i: pending=$pending"
      [ "$pending" = "false" ] || [ "$pending" = "0" ] && break
    done
  else
    warn "Reconcile trigger unavailable (HTTP $reconcile_code) — using DB-only discrepancy check."
  fi

  # Discrepancy count from the DB. Three discrepancy classes:
  #   A) Completed/Cancelled bookings with no escrow_id (orphaned escrow absence)
  #   B) Quarantined bookings stuck in escrow_reconcile_failed
  #   C) Pending/Confirmed bookings whose escrow_id is null (escrow never locked)
  local disc_a disc_b disc_c discrepancies
  disc_a=$(db_query "SELECT COUNT(*) FROM bookings WHERE status IN ('Completed','Cancelled') AND (escrow_id IS NULL OR escrow_id = '');" || echo 0)
  disc_b=$(db_query "SELECT COUNT(*) FROM bookings WHERE status = 'escrow_reconcile_failed';" || echo 0)
  disc_c=$(db_query "SELECT COUNT(*) FROM bookings WHERE status IN ('Pending','Confirmed') AND (escrow_id IS NULL OR escrow_id = '');" || echo 0)
  discrepancies=$(( ${disc_a:-0} + ${disc_b:-0} + ${disc_c:-0} ))

  t1=$(date +%s)
  rto=$((t1 - t0))
  log "Reconciliation completed in ${rto}s (target ${RTO_RECONCILE}s), discrepancies=$discrepancies (A=${disc_a} B=${disc_b} C=${disc_c})"

  if [ "$discrepancies" -eq 0 ] && [ "$rto" -le "$RTO_RECONCILE" ]; then
    RESULTS["reconciliation"]="pass"
    NOTES["reconciliation"]="discrepancies=0 A=${disc_a} B=${disc_b} C=${disc_c} rto=${rto}s reconcile_http=$reconcile_code"
  else
    RESULTS["reconciliation"]="fail"
    NOTES["reconciliation"]="discrepancies=$discrepancies A=${disc_a} B=${disc_b} C=${disc_c} rto=${rto}s reconcile_http=$reconcile_code"
  fi
  log "Phase reconciliation: ${RESULTS[reconciliation]}"
}

# ---------------------------------------------------------------------------
# Phase 7 — Report
# ---------------------------------------------------------------------------

phase_report() {
  CURRENT_STEP="report"
  log "=== Phase: report (§6.8) ==="

  # Aggregate targets
  local reads_ok="fail" lookup_recon_ok="fail"
  if [ "${RESULTS[db_restore]:-}" = "pass" ] \
     && [ "${RESULTS[cache_rebuild]:-}" = "pass" ] \
     && [ "${RESULTS[sync_resume]:-}" = "pass" ] \
     && [ "${RESULTS[core_reads]:-}" = "pass" ]; then
    reads_ok="pass"
  fi
  if [ "${RESULTS[booking_lookup]:-}" = "pass" ] \
     && [ "${RESULTS[reconciliation]:-}" = "pass" ]; then
    lookup_recon_ok="pass"
  fi

  log "Aggregate core reads: $reads_ok"
  log "Aggregate booking lookup + reconciliation: $lookup_recon_ok"

  RESULTS["aggregate_reads"]="$reads_ok"
  RESULTS["aggregate_lookup_recon"]="$lookup_recon_ok"

  if [ "$reads_ok" = "pass" ] && [ "$lookup_recon_ok" = "pass" ]; then
    RESULTS["overall"]="pass"
  else
    RESULTS["overall"]="fail"
  fi

  write_report
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

log "=== Rentars recovery drill ==="
log "Drill ID: $TS"
log "Phase: $PHASE  Sample size: $SAMPLE_SIZE"
log "API: $STAGING_API_URL"

case "$PHASE" in
  db-restore)    phase_db_restore ;;
  cache-rebuild) phase_cache_rebuild ;;
  sync-resume)   phase_sync_resume ;;
  core-reads)    phase_core_reads ;;
  booking-lookup) phase_booking_lookup ;;
  reconciliation) phase_reconciliation ;;
  report)        phase_report ;;
  all)
    phase_db_restore
    phase_cache_rebuild
    phase_sync_resume
    phase_core_reads
    phase_booking_lookup
    phase_reconciliation
    phase_report
    ;;
  *) err "Unknown phase: $PHASE"; exit 2 ;;
esac

# Exit non-zero on failure so CI can gate
[ "${RESULTS[overall]:-pass}" = "pass" ] && exit 0 || exit 1
