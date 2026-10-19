# Automated Database Backup Restore Verification

A backup is only useful if it restores. This document describes the restore drill that proves the Rentars database can be recovered with its schema, extensions, RLS policies, and representative data intact. The drill is implemented in [`scripts/backup-restore-drill.sh`](../scripts/backup-restore-drill.sh) and runs in two places:

- **CI** (`restore-drill` job in `.github/workflows/ci.yml`) on every push and pull request, against the canonical migrations and sanitized seed data in `tests/fixtures/restore-drill/`.
- **Scheduled** (`.github/workflows/restore-drill.yml`) every Monday at 03:30 UTC, against the sanitized nonproduction database.

## What the Drill Does

1. **Export** an encrypted backup (`pg_dump --format=custom`, encrypted with AES-256-CBC via `openssl`, PBKDF2, 600 000 iterations). The plaintext dump is deleted immediately after encryption. A SHA-256 manifest is written alongside the encrypted file. Alternatively, an existing backup can be supplied with `DRILL_SOURCE_BACKUP`.
2. **Verify integrity.** The encrypted file's SHA-256 must match the manifest, the file must decrypt with `BACKUP_ENCRYPTION_KEY`, and `pg_restore --list` must read the archive table of contents. Any mismatch stops the drill: an incomplete or corrupt backup is reported as a failed check.
3. **Restore** into a new, uniquely named database on the scratch instance using `pg_restore --exit-on-error`. The first SQL error fails the drill.
4. **Assert**:
   - Critical tables exist (`users`, `properties`, `bookings`, `payments`, `notifications`, `audit_logs`).
   - Row counts match the source exactly, when the source is available (export mode).
   - Required extensions are installed (`postgis`, `btree_gist` by default; override with `DRILL_REQUIRED_EXTENSIONS`).
   - Row level security is enabled on the policy-bearing tables and at least one policy exists in `public`.
   - No payment references a missing booking, and no booking references a missing property.
   - A representative read succeeds, and a representative audit write is accepted inside a transaction that is then rolled back. The drill confirms the probe row did not survive.
5. **Record** the results. The drill writes `restore-drill-<id>.json` (status, per-check results, backup SHA-256 and size, RTO, backup age) and `restore-drill-<id>.log` to `DRILL_REPORT_DIR`. Both are written even when the drill fails.
6. **Destroy** the temporary database, whether the drill passed or failed, and delete all working files. The report is kept.

The exit status is `0` only when every check passes.

### Recovery metrics

| Metric | Definition in the report |
|--------|--------------------------|
| RTO (`recovery.rto_seconds`) | Seconds from the start of `pg_restore` until validation completes |
| Backup age (`recovery.backup_age_seconds`) | Seconds between the moment the backup was taken and the moment the drill finished. This bounds the data-loss window (RPO) at the time of the drill. |

The RPO a production deployment can actually achieve is determined by how often backups run. Backup age reported by the drill shows whether the most recent backup is within that interval.

## Configuration

Required environment:

| Variable | Purpose |
|----------|---------|
| `BACKUP_ENCRYPTION_KEY` | Passphrase for the encrypted backup. Store it in the secret manager, never in the repository. |
| `VERIFY_DB_HOST`, `VERIFY_DB_USER`, `VERIFY_DB_PASSWORD` | Scratch PostgreSQL instance. The user needs rights to create and drop databases and to create extensions. |
| `PROD_DB_HOST`, `PROD_DB_USER`, `PROD_DB_PASSWORD` | Source database. Required unless `DRILL_SOURCE_BACKUP` is set. Use the sanitized nonproduction database. |

Optional environment:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROD_DB_PORT`, `VERIFY_DB_PORT` | `5432` | Server ports |
| `PROD_DB_NAME` | `rentars` | Source database name |
| `DRILL_SOURCE_BACKUP` | unset | Reuse an encrypted backup instead of exporting; expects `<path>.sha256` beside it |
| `DRILL_BACKUP_OUT` | unset | Keep a copy of the encrypted backup and manifest |
| `DRILL_REPORT_DIR` | `restore-drill-reports` | Where the JSON report and log are written |
| `DRILL_REQUIRED_EXTENSIONS` | `postgis btree_gist` | Extensions that must be installed after restore |

Run locally:

```bash
export BACKUP_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # keep this key to decrypt the backup later
export PROD_DB_HOST=... PROD_DB_USER=... PROD_DB_PASSWORD=...
export VERIFY_DB_HOST=... VERIFY_DB_USER=... VERIFY_DB_PASSWORD=...
bash scripts/backup-restore-drill.sh
```

The drill needs `psql`, `pg_dump`, `pg_restore`, `openssl`, and `sha256sum`. The dump and restore tools should be at least as new as the server.

## Failure Behaviour

| Failure | Check that fails | Drill result |
|---------|------------------|--------------|
| Export cannot connect or dump | — (fatal) | Failed, no backup retained |
| Backup truncated or altered | `backup_checksum` | Failed before any restore |
| Wrong key or unreadable file | `backup_decrypt` | Failed before any restore |
| Archive damaged | `archive_readable` | Failed before any restore |
| Restore error | `restore` | Failed, temporary database dropped |
| Missing table, extension, or RLS | `rows:*`, `extension:*`, `rls:*` | Failed after the restore completes |
| Row count drift vs. source | `rows:*` | Failed |
| Write probe leaves a row behind | `write_probe` | Failed |

A failed workflow run is the alert. Repository notification settings route it to the operations team. Recovery time above the target in the table below should be reviewed from the report even when the drill passes.

## Continuous Verification in CI

The `restore-drill` job:

1. Starts the Supabase Postgres image used by the RLS tests.
2. Applies `apps/backend/database/setup.sql` to a `rentars` database, so the drill restores the real schema and policies.
3. Loads `tests/fixtures/restore-drill/sanitized-seed.sql` (synthetic `.example` identities only).
4. Runs the drill with an ephemeral key generated per run.
5. Truncates a copy of the encrypted backup to half its size and asserts that the drill rejects it.
6. Uploads the reports as an artifact.

## Recovery Time Targets (RTO)

| Scenario | Target RTO | Notes |
|----------|-----------|-------|
| Single table corruption | < 5 minutes | Restore via incremental backup |
| Full database restore | < 30 minutes | Supabase or PostgreSQL backup |
| Schema migration failure | < 15 minutes | Rollback to previous schema version |
| Production failover | < 60 seconds | Hot standby or read replica promotion |

## See Also

- [DEPLOYMENT.md](../DEPLOYMENT.md): deployment procedures and rollback
- [admin-runbooks.md](./admin-runbooks.md): operational runbooks
- PostgreSQL [pg_dump documentation](https://www.postgresql.org/docs/current/app-pgdump.html)
- PostgreSQL [pg_restore documentation](https://www.postgresql.org/docs/current/app-pgrestore.html)
