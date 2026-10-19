# Migration Naming Convention

## Current situation — existing duplicatesThe following numeric prefixes are shared by multiple migration files. These files
have already been applied to deployed environments and **must not be renamed** (renaming
an applied migration confuses any migration-state tracker and is hard to reverse in
production).

| Prefix | Files |
|--------|-------|
| `00002` | `00002_storage_and_rls.sql`, `00002_add_booking_blockchain_fields.sql` |
| `00013` | `00013_add_property_search_vector.sql`, `00013_update_availability_ranges.sql` |
| `00014` | `00014_add_dynamic_pricing.sql`, `00014_pricing_and_settings.sql`, `00014_search_analytics_and_geolocation.sql` |
| `00017` | `00017_add_amenities_gin_index.sql`, `00017_add_email_verification.sql`, `00017_add_geospatial_gist_index.sql`, `00017_add_guest_count_to_bookings.sql`, `00017_add_password_reset_tokens.sql` |
| `00020` | `00020_add_missing_indexes.sql`, `00020_add_property_views.sql`, `00020_add_review_eligibility_constraints.sql` |
| `00021` | `00021_add_booking_reminders.sql`, `00021_add_flag_reason_to_reviews.sql`, `00021_add_rls_wishlists_notifications.sql`, `00021_create_funnel_events.sql` |
| `00028` | `00028_add_property_type_and_bathrooms.sql`, `00028_add_role_to_users.sql`, `00028_booking_lifecycle_disputed_complete.sql`, `00028_create_audit_and_payments.sql`, `00028_create_booking_status_history.sql` |
| `00032` | `00032_add_cancellation_refund_fields.sql`, `00032_add_soft_delete_to_properties.sql`, `00032_add_thumbnail_url_to_property_images.sql`, `00032_create_idempotency_keys_table.sql` |
| `00059` | `00059_create_data_exports_table.sql`, `00059_create_probe_results_table.sql`, `00059_enhance_audit_logs_table.sql`, `00059_enhance_saved_searches.sql`, `00059_search_infrastructure_validation.sql` |
| `00060` | `00060_add_property_draft_status.sql`, `00060_create_account_deletions_table.sql`, `00060_geocoding_status_tracking.sql` |
| `00061` | `00061_enhance_reports_and_moderation.sql`, `00061_search_performance_tracking.sql` |
| `00062` | `00062_add_guest_count_to_booking_modifications.sql`, `00062_add_legal_holds.sql`, `00062_add_quiet_hours_to_notification_preferences.sql`, `00062_booking_date_exclusion_constraint.sql`, `00062_booking_expiry_and_timeout.sql`, `00062_booking_lifecycle_state_machine.sql`, `00062_booking_modifications_snapshot.sql` |

> **Note:** `00012_add_booking_dispute_status.sql` was previously a duplicate of
> `00012_create_property_images_table.sql`. It has been renamed to
> `00035_add_booking_dispute_status.sql` (the next unused prefix at the time of
> resolution). The SQL contents are unchanged.
>
> **Note:** The files with prefixes `00059`–`00062` were applied to deployed
> environments before this document was updated and **must not be renamed**. Their
> canonical application order within each prefix group is listed below.

### Canonical application order for shared prefixes

When running `setup.sql` or a migration runner, apply files with shared prefixes in
the order listed below (alphabetical within each prefix group was the original intent).
Document this in your migration runner configuration.

```
00002_add_booking_blockchain_fields.sql   ← apply first (schema additions)
00002_storage_and_rls.sql                 ← apply second (RLS on existing tables)

00013_add_property_search_vector.sql      ← apply first (new column + index)
00013_update_availability_ranges.sql      ← apply second (column additions)

00014_add_dynamic_pricing.sql             ← apply first (new tables + columns)
00014_search_analytics_and_geolocation.sql ← apply second (new table + geospatial)

00017_add_guest_count_to_bookings.sql     ← apply first  (schema column)
00017_add_amenities_gin_index.sql         ← apply second (index only)
00017_add_email_verification.sql          ← apply third  (schema columns)
00017_add_geospatial_gist_index.sql       ← apply fourth (index only)
00017_add_password_reset_tokens.sql       ← apply fifth  (new table)

00020_add_missing_indexes.sql             ← apply first  (indexes on existing tables)
00020_add_property_views.sql              ← apply second (new table)
00020_add_review_eligibility_constraints.sql ← apply third (constraints)

00021_add_booking_reminders.sql           ← apply first  (new table)
00021_add_flag_reason_to_reviews.sql      ← apply second (column addition)
00021_add_rls_wishlists_notifications.sql ← apply third  (RLS policies)
00021_create_funnel_events.sql            ← apply fourth (new table)

00028_add_property_type_and_bathrooms.sql ← apply first  (schema columns)
00028_add_role_to_users.sql               ← apply second (schema column)
00028_booking_lifecycle_disputed_complete.sql ← apply third (status enum)
00028_create_audit_and_payments.sql       ← apply fourth (new tables)
00028_create_booking_status_history.sql   ← apply fifth  (new table)

00032_add_cancellation_refund_fields.sql     ← apply first  (schema columns)
00032_add_soft_delete_to_properties.sql      ← apply second (schema column)
00032_add_thumbnail_url_to_property_images.sql ← apply third (schema column)
00032_create_idempotency_keys_table.sql      ← apply fourth (new table)
```

The groups below were added when prefixes 00059–00062 were applied to deployed
environments before the naming convention was enforced. They follow the same rule:
files are applied alphabetically within the prefix group.

```
00059_create_data_exports_table.sql          ← apply first  (new table)
00059_create_probe_results_table.sql         ← apply second (new table)
00059_enhance_audit_logs_table.sql           ← apply third  (column additions)
00059_enhance_saved_searches.sql             ← apply fourth (column additions)
00059_search_infrastructure_validation.sql   ← apply fifth  (validation helpers)

00060_add_property_draft_status.sql          ← apply first  (enum/column addition)
00060_create_account_deletions_table.sql     ← apply second (new table)
00060_geocoding_status_tracking.sql          ← apply third  (column additions)

00061_enhance_reports_and_moderation.sql     ← apply first  (column additions)
00061_search_performance_tracking.sql        ← apply second (new table/indexes)

00062_add_guest_count_to_booking_modifications.sql ← apply first  (column addition)
00062_add_legal_holds.sql                          ← apply second (new table + RLS)
00062_add_quiet_hours_to_notification_preferences.sql ← apply third (column addition)
00062_booking_date_exclusion_constraint.sql        ← apply fourth (constraint)
00062_booking_expiry_and_timeout.sql               ← apply fifth  (column additions)
00062_booking_lifecycle_state_machine.sql          ← apply sixth  (trigger/function)
00062_booking_modifications_snapshot.sql           ← apply seventh (new table)
```

---

## Forward-looking convention (all new migrations)

### Rule 1 — Strictly incrementing 5-digit prefix

Every new migration file **must** use the next available prefix after the highest
existing one. As of writing this document the highest prefix is `00064`
(`00064_property_versions.sql`); the next prefix to use is `00065`.

Format:
```
NNNNN_short_description_of_change.sql
```

- `NNNNN` — zero-padded 5-digit integer, e.g. `00065`, `00066`
- `short_description` — snake_case, no spaces, no special characters, ≤ 50 chars

Examples:
```
00065_add_host_verification_timestamps.sql
00066_create_property_availability_cache.sql
```

### Rule 2 — One logical change per migration

Each migration file should represent **one** atomic schema change. If two changes are
logically independent (different tables, unrelated features), use two separate files
with consecutive numbers.

### Rule 3 — CI enforcement

The script `apps/backend/scripts/validate-migrations.ts` is run in CI on every pull
request. It will fail (exit code 1) if any new migration has a duplicate or out-of-order
prefix. The CI step is defined in `.github/workflows/ci.yml` under the `validate-migrations` job.

Run it locally before pushing:
```bash
bun run apps/backend/scripts/validate-migrations.ts
```

### Rule 4 — No renaming applied migrations

Never rename a migration file that has been applied to any shared environment
(staging, production). If the file needs to be corrected, create a **new** migration
that makes the correction.

### Rule 5 — Down-migrations (rollback)

No automated rollback files are required, but if you create one, name it:
```
NNNNN_short_description_of_change.down.sql
```
and never apply it automatically in CI.

---

## Running migrations locally

The authoritative command — the same sequence CI uses — is:

```bash
# Apply the full schema from scratch (canonical order, aborts on first SQL error)
cd apps/backend/database
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f setup.sql
```

Additional helpers:

```bash
# Apply a single migration
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/00065_my_new_migration.sql

# Validate migration filenames (detects duplicates and out-of-order prefixes)
bun run validate:migrations

# Dry-run: see what validate-migrations would report without failing
bun run validate:migrations --dry-run

# Or use the Supabase CLI against your local stack
supabase db reset          # resets and re-applies all migrations
supabase migration up       # applies pending migrations
```
