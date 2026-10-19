#!/usr/bin/env bash
# Upgrade-path test for migration 00067 (#747).
#
# Creates a scratch database, applies the migration to a database that already holds
# listings, backfills in batches, and asserts search works. Exits non-zero on failure.
#
# Requires psql and PGHOST/PGPORT/PGUSER/PGPASSWORD for a role that can CREATE EXTENSION
# postgis. Local run against the CI-equivalent image:
#   docker run -d -e POSTGRES_PASSWORD=postgres -p 55432:5432 supabase/postgres:15.6.1.117
#   PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=postgres ./run-search-rollout.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$(cd "$HERE/../../database/migrations" && pwd)/00067_search_rollout.sql"
DB="${SEARCH_TEST_DB:-search_rollout_test}"

psql -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ${DB}" -c "CREATE DATABASE ${DB}"
psql -d "${DB}" -v ON_ERROR_STOP=1 -v migration="${MIGRATION}" -f "${HERE}/search-rollout.sql"
echo "search rollout upgrade test: PASS"
