-- Upgrade-path test for migration 00067 (#747).
--
-- Simulates an existing database: properties already contain rows that have no
-- search vector and no geography. The migration is then applied, the backfill is
-- run in small batches, and search is asserted to work. The migration is re-run to
-- prove it is idempotent.
--
-- Run with tests/db/run-search-rollout.sh, which supplies:
--   -v migration=<absolute path to 00067_search_rollout.sql>
-- Uses a scratch database. Do not point it at a real environment.

\set ON_ERROR_STOP on

-- Base schema the migration depends on (subset of the real properties table).
CREATE TABLE properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  city TEXT,
  country TEXT,
  amenities TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'available',
  deleted_at TIMESTAMPTZ,
  price_per_night DECIMAL(10, 2),
  bedrooms INTEGER,
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8)
);

CREATE TABLE search_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  result_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Existing data, written before any search objects exist.
INSERT INTO properties (id, title, description, city, country, amenities, price_per_night, bedrooms, latitude, longitude)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Beach cottage', 'Steps from the sand', 'Miami', 'US', ARRAY['Pool'], 180, 2, 25.7617, -80.1918),
  ('00000000-0000-4000-8000-000000000002', 'Downtown loft', 'Quiet street', 'New York', 'US', ARRAY['WiFi'], 240, 1, 40.7128, -74.0060),
  ('00000000-0000-4000-8000-000000000003', 'Mountain cabin', 'Remote, no coordinates', 'Denver', 'US', ARRAY['Fireplace'], 150, 3, NULL, NULL);

-- 1. Apply the migration to the populated database.
\i :migration

-- 2. Backfill in batches of 2 until nothing remains.
DO $$
DECLARE
  touched INTEGER;
  batches INTEGER := 0;
BEGIN
  LOOP
    touched := backfill_search_batch(2);
    EXIT WHEN touched = 0;
    batches := batches + 1;
    IF batches > 100 THEN
      RAISE EXCEPTION 'backfill did not converge after 100 batches';
    END IF;
  END LOOP;
  RAISE NOTICE 'backfill finished in % batch(es)', batches;
END $$;

-- 3. Assertions.
DO $$
DECLARE
  n INTEGER;
  nearest TEXT;
BEGIN
  SELECT count(*) INTO n FROM properties WHERE search_vector IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'expected no rows without search_vector, found %', n; END IF;

  SELECT count(*) INTO n FROM properties
   WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND location IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'expected every geocoded row to have location, found % missing', n; END IF;

  -- Full-text search over existing rows.
  SELECT count(*) INTO n FROM search_properties_ranked('beach');
  IF n <> 1 THEN RAISE EXCEPTION 'search for "beach" expected 1 result, got %', n; END IF;

  -- Geo search: from midtown Manhattan, 50 km, the NYC loft is the nearest result
  -- and Miami is excluded.
  SELECT title INTO nearest FROM search_nearby_properties(40.75, -73.98, 50) LIMIT 1;
  IF nearest IS DISTINCT FROM 'Downtown loft' THEN
    RAISE EXCEPTION 'nearby search expected "Downtown loft" first, got %', nearest;
  END IF;
  SELECT count(*) INTO n FROM search_nearby_properties(40.75, -73.98, 50) WHERE title = 'Beach cottage';
  IF n <> 0 THEN RAISE EXCEPTION 'Miami listing should be outside 50 km of Manhattan'; END IF;

  -- Soft-deleted rows must never appear in search.
  UPDATE properties SET deleted_at = NOW() WHERE title = 'Beach cottage';
  SELECT count(*) INTO n FROM search_properties_ranked('beach');
  IF n <> 0 THEN RAISE EXCEPTION 'soft-deleted listing returned by ranked search'; END IF;
  UPDATE properties SET deleted_at = NULL WHERE title = 'Beach cottage';

  -- Triggers keep new writes indexed without the backfill.
  INSERT INTO properties (title, description, city, amenities, latitude, longitude)
  VALUES ('Lakeside lodge', 'Canoe included', 'Austin', ARRAY['Kayak'], 30.27, -97.74);
  SELECT count(*) INTO n FROM properties WHERE title = 'Lakeside lodge' AND search_vector IS NOT NULL AND location IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'trigger did not populate search data for a new row'; END IF;
  SELECT count(*) INTO n FROM search_properties_ranked('canoe');
  IF n <> 1 THEN RAISE EXCEPTION 'new row not searchable by description'; END IF;

  RAISE NOTICE 'search assertions passed';
END $$;

-- 4. Re-running the migration must succeed and must not change results.
\i :migration
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM search_properties_ranked('beach');
  IF n <> 1 THEN RAISE EXCEPTION 'after re-run, search for "beach" expected 1 result, got %', n; END IF;
  RAISE NOTICE 'idempotent re-run passed';
END $$;
