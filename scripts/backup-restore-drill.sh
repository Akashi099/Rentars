#!/usr/bin/env bash
#
# Backup restore drill (#736).
#
# Exports (or reuses) an encrypted backup, verifies its checksum and archive
# structure, restores it into an isolated database, asserts schema, extension,
# RLS, row-count and referential invariants, records recovery time and backup
# age, and drops the temporary database. A JSON report and the drill log are
# kept in DRILL_REPORT_DIR. The exit status is 0 only when every check passes.
#
# Required environment:
#   BACKUP_ENCRYPTION_KEY                              passphrase for the backup
#   VERIFY_DB_HOST, VERIFY_DB_USER, VERIFY_DB_PASSWORD scratch PostgreSQL instance
#   PROD_DB_HOST, PROD_DB_USER, PROD_DB_PASSWORD        source (sanitized nonprod)
#                                                      unless DRILL_SOURCE_BACKUP is set
#
# Optional environment:
#   PROD_DB_PORT (5432), PROD_DB_NAME (rentars)
#   VERIFY_DB_PORT (5432)
#   DRILL_SOURCE_BACKUP        reuse an encrypted backup instead of exporting one;
#                              expects <path>.sha256 next to it
#   DRILL_BACKUP_OUT           directory that keeps the encrypted backup and checksum
#   DRILL_REPORT_DIR           report directory (default: restore-drill-reports)
#   DRILL_REQUIRED_EXTENSIONS  space-separated extensions (default: "postgis btree_gist")
#
# Usage: bash scripts/backup-restore-drill.sh

set -Eeuo pipefail

CRITICAL_TABLES=(users properties bookings payments notifications audit_logs)
RLS_TABLES=(bookings payments properties notifications audit_logs)
read -r -a REQUIRED_EXTENSIONS <<<"${DRILL_REQUIRED_EXTENSIONS:-postgis btree_gist}"

PROD_DB_PORT="${PROD_DB_PORT:-5432}"
PROD_DB_NAME="${PROD_DB_NAME:-rentars}"
VERIFY_DB_PORT="${VERIFY_DB_PORT:-5432}"
REPORT_DIR="${DRILL_REPORT_DIR:-restore-drill-reports}"
DRILL_ID="$(date -u +%Y%m%dT%H%M%SZ)"
VERIFY_DB="rentars_verify_$(tr -cd '0-9' <<<"$DRILL_ID")"
WORK_DIR="$(mktemp -d)"
LOG_FILE="$WORK_DIR/drill.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

SOURCE_MODE=""
BACKUP_TAKEN_AT=0
BACKUP_BYTES=0
BACKUP_SHA256=""
RESTORE_STARTED_AT=0
RTO_SECONDS=""
VERIFY_CREATED=0
FAILURES=0
CHECKS=()
declare -A SRC_COUNT=()

log() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2
}

fatal() {
  log "FATAL: $*"
  exit 1
}

# check <name> <pass|fail|skipped> <detail>
check() {
  CHECKS+=("$1|$2|$3")
  case "$2" in
    fail)
      FAILURES=$((FAILURES + 1))
      log "FAIL  $1: $3"
      ;;
    *)
      log "$(printf '%-7s' "${2^^}") $1: $3"
      ;;
  esac
}

# Records a failed check and stops: nothing after it can be trusted.
abort_check() {
  check "$1" fail "$2"
  fatal "$2"
}

require_env() {
  local name missing=0
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      log "missing required environment variable: $name"
      missing=1
    fi
  done
  if (( missing )); then
    exit 2
  fi
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || fatal "required tool not found: $tool"
  done
}

pg_src() {
  PGPASSWORD="$PROD_DB_PASSWORD" psql --host="$PROD_DB_HOST" --port="$PROD_DB_PORT" \
    --username="$PROD_DB_USER" --dbname="$PROD_DB_NAME" \
    --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 "$@" 2>>"$LOG_FILE"
}

# pg_verify <database> [psql args...]
pg_verify() {
  local db=$1
  shift
  PGPASSWORD="$VERIFY_DB_PASSWORD" psql --host="$VERIFY_DB_HOST" --port="$VERIFY_DB_PORT" \
    --username="$VERIFY_DB_USER" --dbname="$db" \
    --no-psqlrc -X -q -At -v ON_ERROR_STOP=1 "$@" 2>>"$LOG_FILE"
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'
}

write_report() {
  local rc=$1 status=passed now backup_age=null sep="" entry name state detail
  if (( rc != 0 || FAILURES > 0 )); then
    status=failed
  fi
  now="$(date +%s)"
  if (( BACKUP_TAKEN_AT > 0 )); then
    backup_age=$((now - BACKUP_TAKEN_AT))
  fi

  mkdir -p "$REPORT_DIR"
  {
    printf '{\n'
    printf '  "drill_id": "%s",\n' "$DRILL_ID"
    printf '  "status": "%s",\n' "$status"
    printf '  "started_at": "%s",\n' "$STARTED_AT"
    printf '  "finished_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "backup": {"source": "%s", "sha256": "%s", "bytes": %s, "taken_at_epoch": %s},\n' \
      "$SOURCE_MODE" "$BACKUP_SHA256" "$BACKUP_BYTES" "$BACKUP_TAKEN_AT"
    printf '  "recovery": {"rto_seconds": %s, "backup_age_seconds": %s},\n' \
      "${RTO_SECONDS:-null}" "$backup_age"
    printf '  "checks": [\n'
    for entry in "${CHECKS[@]}"; do
      IFS='|' read -r name state detail <<<"$entry"
      printf '%s    {"name": "%s", "status": "%s", "detail": "%s"}' \
        "$sep" "$(json_escape "$name")" "$state" "$(json_escape "$detail")"
      sep=$',\n'
    done
    printf '\n  ]\n}\n'
  } >"$REPORT_FILE"

  cp "$LOG_FILE" "$REPORT_DIR/restore-drill-$DRILL_ID.log" 2>/dev/null || true
}

drop_verify_db() {
  pg_verify postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\"" >/dev/null 2>&1 || true
}

finish() {
  local rc=$?
  set +e
  if (( VERIFY_CREATED )); then
    drop_verify_db
    log "Dropped temporary database $VERIFY_DB"
  fi
  write_report "$rc"
  log "Report written to $REPORT_FILE"
  rm -rf "$WORK_DIR"
  if (( rc == 0 && FAILURES > 0 )); then
    rc=1
  fi
  exit "$rc"
}

REPORT_FILE="$REPORT_DIR/restore-drill-$DRILL_ID.json"
trap finish EXIT

use_provided_backup() {
  local src="$DRILL_SOURCE_BACKUP"
  if [[ ! -f "$src" || ! -f "$src.sha256" ]]; then
    fatal "DRILL_SOURCE_BACKUP requires $src and $src.sha256"
  fi
  cp "$src" "$WORK_DIR/backup.dump.enc"
  cp "$src.sha256" "$WORK_DIR/backup.dump.enc.sha256"
  BACKUP_TAKEN_AT="$(stat -c %Y "$src")"
  SOURCE_MODE=provided
  log "Using provided backup $src"
}

export_backup() {
  local dump="$WORK_DIR/backup.dump" t
  SOURCE_MODE=export
  BACKUP_TAKEN_AT="$(date -u +%s)"
  log "Exporting backup from $PROD_DB_HOST:$PROD_DB_PORT/$PROD_DB_NAME"

  # spatial_ref_sys is PostGIS reference data that CREATE EXTENSION populates on
  # install. Restoring its rows over the extension's copy fails on managed
  # databases, so only its structure is captured.
  PGPASSWORD="$PROD_DB_PASSWORD" pg_dump --host="$PROD_DB_HOST" --port="$PROD_DB_PORT" \
    --username="$PROD_DB_USER" --format=custom --no-owner --no-acl \
    --exclude-table-data=spatial_ref_sys \
    --file="$dump" "$PROD_DB_NAME" 2>>"$LOG_FILE" \
    || fatal "pg_dump failed (see drill log)"

  # Source counts are taken from the same database the dump came from, so the
  # restored counts can be compared exactly. The source must be quiescent (the
  # sanitized nonprod snapshot), otherwise writes between dump and count show up
  # as mismatches.
  for t in "${CRITICAL_TABLES[@]}"; do
    SRC_COUNT[$t]="$(pg_src -c "SELECT count(*) FROM public.$t")" \
      || fatal "source table $t is unreadable"
  done

  openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass env:BACKUP_ENCRYPTION_KEY \
    -in "$dump" -out "$WORK_DIR/backup.dump.enc" 2>>"$LOG_FILE" \
    || fatal "encryption of the backup failed"
  rm -f "$dump"

  sha256sum "$WORK_DIR/backup.dump.enc" | awk '{print $1}' >"$WORK_DIR/backup.dump.enc.sha256"
  log "Backup encrypted and checksummed"
}

retain_backup() {
  if [[ -z "${DRILL_BACKUP_OUT:-}" ]]; then
    return
  fi
  mkdir -p "$DRILL_BACKUP_OUT"
  cp "$WORK_DIR/backup.dump.enc" "$DRILL_BACKUP_OUT/restore-drill-$DRILL_ID.dump.enc"
  cp "$WORK_DIR/backup.dump.enc.sha256" "$DRILL_BACKUP_OUT/restore-drill-$DRILL_ID.dump.enc.sha256"
  log "Retained encrypted backup in $DRILL_BACKUP_OUT"
}

verify_checksum() {
  local expected actual
  expected="$(awk 'NR == 1 {print $1}' "$WORK_DIR/backup.dump.enc.sha256")"
  actual="$(sha256sum "$WORK_DIR/backup.dump.enc" | awk '{print $1}')"
  BACKUP_SHA256="$actual"
  BACKUP_BYTES="$(stat -c %s "$WORK_DIR/backup.dump.enc")"

  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    abort_check backup_checksum "sha256 does not match manifest: backup is incomplete or corrupt"
  fi
  check backup_checksum pass "sha256 matches manifest ($BACKUP_BYTES bytes)"
}

decrypt_backup() {
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_ENCRYPTION_KEY \
    -in "$WORK_DIR/backup.dump.enc" -out "$WORK_DIR/backup.dump" 2>>"$LOG_FILE" \
    || abort_check backup_decrypt "decryption failed: wrong key or corrupt file"
  check backup_decrypt pass "decrypted with BACKUP_ENCRYPTION_KEY"
}

inspect_archive() {
  local entries
  if ! pg_restore --list "$WORK_DIR/backup.dump" >"$WORK_DIR/toc.txt" 2>>"$LOG_FILE"; then
    abort_check archive_readable "pg_restore cannot read the archive table of contents"
  fi
  entries="$(grep -c ' TABLE ' "$WORK_DIR/toc.txt" || true)"
  check archive_readable pass "archive lists $entries table definitions"
}

create_verify_db() {
  pg_verify postgres -c "CREATE DATABASE \"$VERIFY_DB\"" >/dev/null \
    || fatal "could not create $VERIFY_DB"
  VERIFY_CREATED=1
  log "Created temporary database $VERIFY_DB"
}

restore_backup() {
  RESTORE_STARTED_AT="$(date +%s)"
  if ! PGPASSWORD="$VERIFY_DB_PASSWORD" pg_restore --host="$VERIFY_DB_HOST" \
    --port="$VERIFY_DB_PORT" --username="$VERIFY_DB_USER" --dbname="$VERIFY_DB" \
    --no-owner --no-acl --exit-on-error "$WORK_DIR/backup.dump" >>"$LOG_FILE" 2>&1; then
    abort_check restore "pg_restore --exit-on-error failed (see drill log)"
  fi
  rm -f "$WORK_DIR/backup.dump"
  check restore pass "restored into $VERIFY_DB"
}

validate_restore() {
  local t count ext n rls policies orphans inserted remaining

  for t in "${CRITICAL_TABLES[@]}"; do
    if ! count="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM public.$t")"; then
      check "rows:$t" fail "table missing or unreadable after restore"
      continue
    fi
    if [[ -n "${SRC_COUNT[$t]:-}" ]]; then
      if [[ "$count" == "${SRC_COUNT[$t]}" ]]; then
        check "rows:$t" pass "$count rows match source"
      else
        check "rows:$t" fail "restored $count rows, source had ${SRC_COUNT[$t]}"
      fi
    else
      check "rows:$t" skipped "$count rows restored; no source to compare"
    fi
  done

  for ext in "${REQUIRED_EXTENSIONS[@]}"; do
    n="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM pg_extension WHERE extname = '$ext'")"
    if [[ "$n" == 1 ]]; then
      check "extension:$ext" pass "installed"
    else
      check "extension:$ext" fail "not installed after restore"
    fi
  done

  for t in "${RLS_TABLES[@]}"; do
    rls="$(pg_verify "$VERIFY_DB" -c "SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.$t')")"
    if [[ "$rls" == "t" ]]; then
      check "rls:$t" pass "row level security enabled"
    else
      check "rls:$t" fail "row level security missing or table absent"
    fi
  done

  policies="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM pg_policies WHERE schemaname = 'public'")"
  if (( policies > 0 )); then
    check rls_policies pass "$policies policies in public schema"
  else
    check rls_policies fail "no RLS policies in public schema"
  fi

  orphans="$(pg_verify "$VERIFY_DB" -c "
    SELECT (SELECT count(*) FROM payments p WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.id = p.booking_id))
         + (SELECT count(*) FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM properties pr WHERE pr.id = b.property_id))")"
  if [[ "$orphans" == 0 ]]; then
    check references pass "no orphaned payments or bookings"
  else
    check references fail "$orphans orphaned payment or booking rows"
  fi

  if pg_verify "$VERIFY_DB" -c "SELECT id, email FROM users LIMIT 1" >/dev/null; then
    check read_probe pass "user read succeeded"
  else
    check read_probe fail "user read failed"
  fi

  # Write probe: insert an audit row, prove it is visible inside the
  # transaction, roll back, then confirm no probe row survived.
  inserted="$(pg_verify "$VERIFY_DB" 2>>"$LOG_FILE" <<'SQL' | tail -n 1
BEGIN;
WITH ins AS (
  INSERT INTO audit_logs (actor_id, action, target_type, metadata)
  SELECT id, 'restore_drill.write_probe', 'restore_drill', '{}'::jsonb FROM users LIMIT 1
  RETURNING 1
)
SELECT count(*) FROM ins;
ROLLBACK;
SQL
)"
  remaining="$(pg_verify "$VERIFY_DB" -c "SELECT count(*) FROM audit_logs WHERE action = 'restore_drill.write_probe'")"
  if [[ "$inserted" == 1 && "$remaining" == 0 ]]; then
    check write_probe pass "audit insert accepted and rolled back"
  else
    check write_probe fail "insert returned '$inserted', probe rows left after rollback: '$remaining'"
  fi

  RTO_SECONDS=$(( $(date +%s) - RESTORE_STARTED_AT ))
}

main() {
  require_env BACKUP_ENCRYPTION_KEY VERIFY_DB_HOST VERIFY_DB_USER VERIFY_DB_PASSWORD
  if [[ -z "${DRILL_SOURCE_BACKUP:-}" ]]; then
    require_env PROD_DB_HOST PROD_DB_USER PROD_DB_PASSWORD
    require_tools pg_dump
  fi
  require_tools psql pg_restore openssl sha256sum awk sed

  log "=== Backup restore drill $DRILL_ID ==="
  if [[ -n "${DRILL_SOURCE_BACKUP:-}" ]]; then
    use_provided_backup
  else
    export_backup
  fi
  retain_backup
  verify_checksum
  decrypt_backup
  inspect_archive
  create_verify_db
  restore_backup
  validate_restore

  if (( FAILURES > 0 )); then
    fatal "$FAILURES check(s) failed"
  fi
  log "Drill passed: RTO ${RTO_SECONDS}s, backup age $(( $(date +%s) - BACKUP_TAKEN_AT ))s"
}

main "$@"
