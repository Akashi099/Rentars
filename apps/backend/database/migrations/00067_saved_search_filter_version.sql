-- Migration 00067: Record the filter schema version for saved searches (issue #751)
-- Filters are normalised on write (see apps/backend/src/utils/savedSearchAlerts.ts).
-- The version says which normalisation rules produced the stored filters, so a
-- future change to those rules can tell old rows apart from new ones. This is
-- separate from the row `version` column, which counts updates to the row.

ALTER TABLE saved_searches
  ADD COLUMN IF NOT EXISTS filter_version INTEGER NOT NULL DEFAULT 1;
