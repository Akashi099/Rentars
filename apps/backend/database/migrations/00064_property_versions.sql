-- #597: Support listing version history and rollback.
--
-- Every meaningful update to a property creates an immutable snapshot of the
-- fields that were changed.  Active bookings continue to reference their
-- original agreed terms; the version table gives hosts and admins full
-- traceability of who changed what and when.
--
-- Fields that affect active bookings (tracked):
--   title, description, price_per_night, bedrooms, bathrooms, max_guests,
--   amenities, pets_allowed, smoking_allowed, events_allowed, quiet_hours_start,
--   quiet_hours_end, additional_rules, address, city, country, property_type
--
-- Rollback creates a new version (the restore point) rather than deleting
-- history, so the audit trail is never mutated.

CREATE TABLE IF NOT EXISTS property_versions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  version_number INTEGER    NOT NULL,
  -- Snapshot of the full tracked field set at the time of the change.
  snapshot      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Which fields changed in this version (array of field names).
  changed_fields TEXT[]     NOT NULL DEFAULT '{}',
  -- Who made the change and when.
  changed_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  change_source VARCHAR(50) NOT NULL DEFAULT 'host_edit',
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_property_versions_property_version
    UNIQUE (property_id, version_number)
);

-- Efficient look-up of all versions for a property in reverse chronological order.
CREATE INDEX IF NOT EXISTS idx_property_versions_property_id
  ON property_versions(property_id, version_number DESC);

-- Allow fast actor queries (e.g. "all changes by admin X").
CREATE INDEX IF NOT EXISTS idx_property_versions_changed_by
  ON property_versions(changed_by)
  WHERE changed_by IS NOT NULL;

-- Sequence function: returns the next version number for a property.
CREATE OR REPLACE FUNCTION next_property_version(p_property_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(MAX(version_number), 0) + 1
  FROM property_versions
  WHERE property_id = p_property_id
$$;
