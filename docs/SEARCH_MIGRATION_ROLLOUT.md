# Advanced Search: Database Rollout (#747)

This runbook covers applying the search database objects to an existing environment
without blocking listing reads or writes, backfilling existing listings, and recovering
if something goes wrong.

## What changes

| Object | Migration | Notes |
|--------|-----------|-------|
| `properties.search_vector`, `latitude`, `longitude`, `location` | `00067` | Nullable, no default. Metadata-only, no table rewrite. |
| Triggers `trg_properties_search_vector_update`, `trg_properties_location_update` | `00067` | Keep new writes indexed. |
| `search_properties_ranked`, `search_nearby_properties`, `get_search_suggestions` | `00067` | Redefined. `search_nearby_properties` now uses `ST_Distance`. |
| GIN index on `search_vector`, GiST index on `location`, lat/long index | `00067` | Built with `CREATE INDEX CONCURRENTLY`. |
| `backfill_search_batch(int)` | `00067` | Fills existing rows, a few hundred at a time. |

`00059_search_infrastructure_validation.sql` defines the same objects, but
`search_nearby_properties` there calls `ST_DistanceSphere` on `geography` values, which
PostGIS rejects. Use `00067` for rollout. It is forward-only and idempotent, so it is
safe whether or not `00059` has already run in an environment.

## Preconditions

1. PostGIS is available on the server (`SELECT 1 FROM pg_available_extensions WHERE name = 'postgis';`).
   Migration `00067` checks this first and fails with a clear message if it is missing.
2. The role applying the migration can `CREATE EXTENSION postgis` and create indexes.
3. `properties` and `search_analytics` exist. `search_analytics` comes from `00014`.
4. Staging has been rehearsed with a copy of production data (see below).

## Step 1: Rehearse on staging

Estimate index cost from the real table before touching production:

```sql
SELECT count(*) AS listings,
       pg_size_pretty(pg_total_relation_size('properties')) AS table_size
FROM properties;

SELECT count(*) AS needs_backfill
FROM properties
WHERE search_vector IS NULL
   OR (location IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL);
```

Concurrent index builds take longer than a plain build and use more I/O. Schedule the
rehearsal to measure duration.

## Step 2: Apply the migration

The migration must run outside a transaction because it builds indexes concurrently.
Apply it with `psql`, which does not wrap the file in one:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/backend/database/migrations/00067_search_rollout.sql
```

Runners that wrap each migration in a transaction (for example the Supabase CLI) will
fail on `CREATE INDEX CONCURRENTLY`. Apply `00067` with `psql` in that case.

Listing reads and writes continue during this step. The only locks taken are brief
catalog locks for `ADD COLUMN` and trigger recreation.

## Step 3: Backfill existing listings

```bash
cd apps/backend
bun run scripts/backfill-search.ts --dry-run          # how many rows need work
bun run scripts/backfill-search.ts --batch-size 500 --sleep-ms 200
```

The backfill is resumable. Each batch commits on its own, so an interruption loses at
most one batch. Re-running the script continues from the rows that still need work.

## Step 4: Validate before enabling traffic

```sql
-- Nothing left to backfill (expect 0)
SELECT count(*) FROM properties
WHERE search_vector IS NULL
   OR (location IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL);

-- Indexes are valid (expect 3 rows, all valid)
SELECT c.relname, i.indisvalid
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN ('idx_properties_search_vector_gin',
                    'idx_properties_location_gist',
                    'idx_properties_latitude_longitude');

-- Plan uses the GIN index
EXPLAIN SELECT id FROM properties
WHERE search_vector @@ plainto_tsquery('english', 'beach') AND deleted_at IS NULL;
```

Then smoke-test the API: a text query, a nearby query, and an autocomplete request.

## Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `Invalid index left by an interrupted build` | A concurrent build was interrupted and left an `INVALID` index | `DROP INDEX CONCURRENTLY IF EXISTS <name>;` for each named index, then re-run `00067` |
| Backfill stops partway | Network or database interruption | Re-run `backfill-search.ts`. It resumes from remaining rows. |
| Search returns fewer results than expected | Backfill incomplete | Re-run the backfill, then re-check the validation query |
| Need to roll back | Search must be turned off | Stop traffic to search endpoints. Drop indexes with `DROP INDEX CONCURRENTLY`. The columns, triggers and functions are additive and can stay; they cost little and keep new writes indexed. |

The migration is forward-only. Do not edit `00067` after it has run anywhere. Ship a
fix as a new migration.

## Known blocker: fresh environments

`apps/backend/database/setup.sql` (the CI path) currently fails on `main` before it
reaches the search migrations. It reports 28 SQL errors in the historical migrations,
including `00002_storage_and_rls.sql` (references `profiles` before it exists) and
`00013`/`00014` (syntax errors). Until those are resolved, a fresh environment cannot
be built from `setup.sql`, so this runbook covers upgrades only. The upgrade path is
tested by `apps/backend/tests/db/run-search-rollout.sh` and the
`search-rollout-upgrade` CI job.
