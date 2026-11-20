-- Migration 00072 (#924): enforce stable, well-formed property slugs in the database.
--
-- Policy: a property's slug is set once and never changes. Changing a title or
-- city does not change the slug, so an old URL can never start resolving to a
-- different listing. The application already follows this; the trigger makes
-- the database enforce it for every writer, not only the API.
--
-- 1. A trigger rejects any UPDATE that changes a slug which is already set.
--    NULL -> value is still allowed, so legacy rows can be backfilled.
-- 2. A CHECK constraint requires the lowercase, hyphen-separated format that
--    generateSlug produces. It is added NOT VALID so it applies to new and
--    changed rows without scanning existing ones. Existing rows already match
--    the format from the 00024 backfill.
-- 3. The unique index idx_properties_slug (migration 00024) already guarantees
--    global uniqueness. Collisions are retried on the application side.

CREATE OR REPLACE FUNCTION prevent_property_slug_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.slug IS NOT NULL AND NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'SLUG_IMMUTABLE: property slug % cannot be changed', OLD.slug
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_slug_immutable ON properties;

CREATE TRIGGER trg_properties_slug_immutable
  BEFORE UPDATE OF slug ON properties
  FOR EACH ROW
  EXECUTE FUNCTION prevent_property_slug_change();

ALTER TABLE properties
  DROP CONSTRAINT IF EXISTS properties_slug_format_check;

ALTER TABLE properties
  ADD CONSTRAINT properties_slug_format_check
  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
  NOT VALID;
