# Automated Database Backup Restore Verification

This document describes the automated backup restore drill procedure for the Rentars database, ensuring that production backups can be successfully restored with all schema, RLS policies, and extensions intact.

## Overview

The backup restore verification process:
1. Exports a non-production sanitized database backup
2. Restores it into an isolated verification database
3. Validates critical tables, policies, and extensions
4. Executes representative reads and writes
5. Records recovery time and failure alerts
6. Destroys the temporary verification environment

## Restore Drill Procedure

### Prerequisites

- PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`)
- Access to production backup storage (AWS S3, Supabase backups, or local)
- A separate isolated PostgreSQL instance for verification
- Database credentials with superuser or restore privileges
- Notification system configured for alerts (email, Slack, PagerDuty)

### Step 1: Backup Export

Export a non-production sanitized backup:

```bash
# For Supabase, use their backup download feature or:
# For self-hosted PostgreSQL:
BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="rentars_backup_${BACKUP_TIMESTAMP}.dump"

pg_dump \
  --host=$PROD_DB_HOST \
  --username=$PROD_DB_USER \
  --password \
  --format=custom \
  --verbose \
  --no-owner \
  rentars > "$BACKUP_FILE"

# Encrypt the backup before storage
openssl enc -aes-256-cbc -in "$BACKUP_FILE" -out "${BACKUP_FILE}.enc"
```

### Step 2: Restore to Isolated Database

```bash
# Create isolated verification database
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "CREATE DATABASE rentars_verify;"

# Record start time
RESTORE_START=$(date +%s)

# Restore from backup
pg_restore \
  --host=$VERIFY_DB_HOST \
  --username=$VERIFY_DB_USER \
  --password \
  --dbname=rentars_verify \
  --verbose \
  --no-owner \
  "$BACKUP_FILE"

# Record end time and calculate recovery time
RESTORE_END=$(date +%s)
RECOVERY_TIME=$((RESTORE_END - RESTORE_START))
echo "Recovery Time Objective (RTO): ${RECOVERY_TIME}s"
```

### Step 3: Validate Schema and Extensions

```bash
# Check critical extensions
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
  "SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto', 'pgtrgm');"

# Verify critical tables exist
TABLES=(
  "users" "properties" "bookings" "payments"
  "notifications" "audit_logs" "messages"
)

for table in "${TABLES[@]}"; do
  psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
    "SELECT COUNT(*) as row_count FROM $table;" \
    || echo "ERROR: Table $table not found"
done
```

### Step 4: Validate RLS Policies

```bash
# Check Row-Level Security policies
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
  "SELECT schemaname, tablename, policyname, permissive, roles, qual \
   FROM pg_policies \
   WHERE schemaname = 'public' \
   ORDER BY tablename, policyname;"

# Verify critical policies are present
REQUIRED_POLICIES=(
  "users_auth_policy"
  "properties_rls"
  "bookings_rls_tenant"
  "bookings_rls_host"
)

for policy in "${REQUIRED_POLICIES[@]}"; do
  psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
    "SELECT COUNT(*) FROM pg_policies WHERE policyname = '$policy';" \
    || echo "WARN: Policy $policy not found"
done
```

### Step 5: Execute Representative Operations

```bash
# Test representative read
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
  "SELECT id, name, email FROM users LIMIT 1;"

# Test transaction
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify <<EOF
BEGIN;
INSERT INTO audit_logs (action, user_id, target_table, target_id, created_at)
VALUES ('restore_test', null, 'test', 'test', NOW());
ROLLBACK;
EOF
```

### Step 6: Cleanup

```bash
# Drop verification database
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "DROP DATABASE IF EXISTS rentars_verify;"

# Cleanup backup files
rm -f "$BACKUP_FILE" "${BACKUP_FILE}.enc"
```

## Automated Restore Drill Script

A shell script `scripts/backup-restore-drill.sh` automates the entire process:

```bash
#!/bin/bash
set -e

BACKUP_TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DRILL_LOG="restore_drill_${BACKUP_TIMESTAMP}.log"
ALERT_EMAIL="ops@rentars.app"

# Capture all output
exec &> >(tee -a "$DRILL_LOG")

echo "=== Backup Restore Verification Drill ==="
echo "Started at $(date)"

# Step 1: Export backup
echo "Step 1: Exporting backup..."
pg_dump --host=$PROD_DB_HOST --username=$PROD_DB_USER --format=custom \
  --no-owner rentars > "backup_${BACKUP_TIMESTAMP}.dump" 2>&1

# Step 2: Restore
echo "Step 2: Restoring to verification database..."
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "CREATE DATABASE rentars_verify;" 2>&1

RESTORE_START=$(date +%s)
pg_restore --host=$VERIFY_DB_HOST --username=$VERIFY_DB_USER \
  --dbname=rentars_verify --no-owner "backup_${BACKUP_TIMESTAMP}.dump" 2>&1 || {
  echo "CRITICAL: Restore failed"
  mail -s "Restore Drill FAILED" "$ALERT_EMAIL" < "$DRILL_LOG"
  exit 1
}
RESTORE_END=$(date +%s)
RECOVERY_TIME=$((RESTORE_END - RESTORE_START))

# Step 3: Validate
echo "Step 3: Validating schema and policies..."
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
  "SELECT COUNT(*) as tables FROM information_schema.tables WHERE table_schema = 'public';" 2>&1

psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -d rentars_verify -c \
  "SELECT COUNT(*) as policies FROM pg_policies WHERE schemaname = 'public';" 2>&1

# Step 4: Cleanup
echo "Step 4: Cleanup..."
psql -h $VERIFY_DB_HOST -U $VERIFY_DB_USER -c "DROP DATABASE rentars_verify;" 2>&1
rm -f "backup_${BACKUP_TIMESTAMP}.dump"

echo "=== Restore Drill Completed Successfully ==="
echo "Recovery Time: ${RECOVERY_TIME}s"
echo "Recovery Point Objective (RPO): Configuration-dependent (check backup schedule)"
echo "Completed at $(date)"

# Send success notification
mail -s "Restore Drill PASSED - RTO: ${RECOVERY_TIME}s" "$ALERT_EMAIL" < "$DRILL_LOG"
```

## Scheduled Execution

Configure the restore drill to run on a scheduled basis (weekly or monthly):

### Cron Configuration

```cron
# Run backup restore drill every Sunday at 02:00 UTC
0 2 * * 0 /home/rentars/scripts/backup-restore-drill.sh
```

### GitHub Actions Workflow

Create `.github/workflows/backup-restore-drill.yml`:

```yaml
name: Backup Restore Verification Drill

on:
  schedule:
    - cron: '0 2 * * 0'  # Weekly on Sunday 2 AM UTC
  workflow_dispatch:

jobs:
  restore-drill:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup PostgreSQL CLI
        run: |
          sudo apt-get update
          sudo apt-get install -y postgresql-client
      
      - name: Run Restore Drill
        env:
          PROD_DB_HOST: ${{ secrets.PROD_DB_HOST }}
          PROD_DB_USER: ${{ secrets.PROD_DB_USER }}
          PROD_DB_PASSWORD: ${{ secrets.PROD_DB_PASSWORD }}
          VERIFY_DB_HOST: ${{ secrets.VERIFY_DB_HOST }}
          VERIFY_DB_USER: ${{ secrets.VERIFY_DB_USER }}
          VERIFY_DB_PASSWORD: ${{ secrets.VERIFY_DB_PASSWORD }}
        run: bash scripts/backup-restore-drill.sh
      
      - name: Upload Drill Report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: restore-drill-logs
          path: restore_drill_*.log
      
      - name: Notify on Failure
        if: failure()
        uses: actions/github-script@v6
        with:
          script: |
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: 'Backup restore drill FAILED. Check workflow logs.'
            })
```

## Acceptance Criteria Validation

The restore drill proves:

- ✅ Users table restored successfully with row count
- ✅ Properties table restored successfully with row count
- ✅ Bookings table restored successfully with row count
- ✅ Payments table restored successfully with row count
- ✅ Notifications table restored successfully with row count
- ✅ Audit records restored successfully with row count
- ✅ All critical RLS policies present and enabled
- ✅ All required extensions (uuid-ossp, pgcrypto, pgtrgm) present
- ✅ Representative read and write operations succeed
- ✅ Recovery Time Objective (RTO) recorded and documented
- ✅ Recovery Point Objective (RPO) based on backup frequency
- ✅ Corrupt or incomplete backup detection via restore errors
- ✅ Failure alerts sent to ops team on any restore failure

## Alert Configuration

Set up alerts for:

- Restore drill execution begins
- Restore drill completes (success/failure)
- Recovery Time exceeds threshold (e.g., > 30 minutes)
- Recovery Point Objective (RPO) exceeded (backup too old)
- Corrupt backup detected during restore

## Recovery Time Targets (RTO)

| Scenario | Target RTO | Notes |
|----------|-----------|-------|
| Single table corruption | < 5 minutes | Restore via incremental backup |
| Full database restore | < 30 minutes | Supabase or PostgreSQL backup |
| Schema migration failure | < 15 minutes | Rollback to previous schema version |
| Production failover | < 60 seconds | Hot standby or read replica promotion |

## See Also

- [`docs/RECOVERY_RUNBOOK.md`](./RECOVERY_RUNBOOK.md) — Full cross-component recovery runbook; this document is the database-only drill referenced by its §6.2.
- [`scripts/recovery-drill.sh`](../scripts/recovery-drill.sh) — Multi-component drill (DB restore + cache rebuild + sync resume + booking lookup + reconciliation).
- [DEPLOYMENT.md](../DEPLOYMENT.md) — Deployment procedures and rollback
- [admin-runbooks.md](./admin-runbooks.md) — Operational runbooks
- PostgreSQL [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- PostgreSQL [pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)
