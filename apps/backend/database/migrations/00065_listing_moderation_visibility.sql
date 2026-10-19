-- #753: Separate moderation visibility from soft deletion.
--
-- Hiding a listing for moderation must not look like a host deletion, so that
-- lifting a hide never resurrects a listing the host removed. Visibility is
-- therefore tracked in its own column.
--
-- Legacy note: earlier builds hid listings by setting deleted_at. Those rows keep
-- deleted_at and are not converted automatically; a moderator must review them.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS moderation_state      VARCHAR(20) NOT NULL DEFAULT 'visible'
    CHECK (moderation_state IN ('visible', 'hidden')),
  ADD COLUMN IF NOT EXISTS moderation_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_properties_moderation_state
  ON properties(moderation_state);

COMMENT ON COLUMN properties.moderation_state IS
  'Public visibility set by moderation decisions. Independent of deleted_at (host removal) and draft_status.';
