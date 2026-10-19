-- Migration 00067: Advanced search rollout (#747)
--
-- Forward-only and idempotent. It completes the search objects that 00059 defines
-- and adds what an existing database needs before search can be enabled:
--
--   1. Precondition: PostGIS must be installable by this role (fails early, clearly).
--   2. Columns and triggers, so new and existing rows get search_vector and location.
--   3. Search functions, redefined with the signatures the API calls.
--   4. Indexes built with CREATE INDEX CONCURRENTLY, so listing reads and writes are
--      not blocked while the index builds.
--   5. backfill_search_batch(): fills existing rows in small batches. Run it with
--      apps/backend/scripts/backfill-search.ts, not in this file, so a long backfill
--      does not hold one transaction open.
--   6. Validation: fails the migration if any required object is missing or invalid.
--
-- RUNNER REQUIREMENT: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- psql -f setup.sql (used by CI) satisfies this. Runners that wrap each file in a
-- transaction (for example the Supabase CLI) must apply this file with psql instead.
-- See docs/SEARCH_MIGRATION_ROLLOUT.md for the full procedure and recovery steps.

-- 1. Precondition ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    RAISE EXCEPTION 'PostGIS is not available on this server. Install it, then re-run 00067.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS postgis;

-- 2. Columns ─────────────────────────────────────────────────────────────────────
-- Nullable with no default: these are metadata-only changes and do not rewrite the table.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS location geography(POINT, 4326);

-- 3. Trigger functions and triggers ──────────────────────────────────────────────
-- Same logic as 00014/00033/00059. The triggers fire only when the listed columns are
-- written, which is why backfill_search_batch() assigns those columns to themselves.
CREATE OR REPLACE FUNCTION properties_location_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL THEN
    NEW.location = ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_location_update ON properties;
CREATE TRIGGER trg_properties_location_update
BEFORE INSERT OR UPDATE OF latitude, longitude
ON properties
FOR EACH ROW
EXECUTE FUNCTION properties_location_update();

CREATE OR REPLACE FUNCTION properties_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector =
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.city, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.amenities, ' '), '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_properties_search_vector_update ON properties;
CREATE TRIGGER trg_properties_search_vector_update
BEFORE INSERT OR UPDATE OF title, description, city, amenities
ON properties
FOR EACH ROW
EXECUTE FUNCTION properties_search_vector_update();

-- 4. Search functions ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION search_nearby_properties(
  lat DECIMAL,
  lng DECIMAL,
  radius_km INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  price_per_night DECIMAL,
  city TEXT,
  country TEXT,
  bedrooms INTEGER,
  amenities TEXT[],
  distance_km DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.title,
    p.price_per_night,
    p.city,
    p.country,
    p.bedrooms,
    p.amenities,
    -- ST_Distance on geography returns metres (ST_DistanceSphere rejects geography).
    ROUND(ST_Distance(
      ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
      p.location
    ) / 1000)::DECIMAL AS distance_km
  FROM properties p
  WHERE p.status = 'available'
    AND p.deleted_at IS NULL
    AND p.location IS NOT NULL
    AND ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, radius_km * 1000)
  ORDER BY distance_km ASC;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_properties_ranked(
  search_query text,
  result_limit integer DEFAULT 20,
  result_offset integer DEFAULT 0
)
RETURNS SETOF jsonb AS $$
BEGIN
  RETURN QUERY
  SELECT to_jsonb(p.*) || jsonb_build_object('rank', ts_rank_cd(p.search_vector, plainto_tsquery('english', search_query)))
  FROM properties p
  WHERE p.search_vector @@ plainto_tsquery('english', search_query)
    AND p.deleted_at IS NULL
  ORDER BY ts_rank_cd(p.search_vector, plainto_tsquery('english', search_query)) DESC
  LIMIT result_limit
  OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_search_suggestions(
  search_prefix TEXT,
  limit_count INTEGER DEFAULT 10
)
RETURNS TABLE (
  query TEXT,
  frequency BIGINT,
  result_count INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sa.query,
    COUNT(*)::BIGINT AS frequency,
    AVG(sa.result_count)::INTEGER AS result_count
  FROM search_analytics sa
  WHERE sa.query ILIKE search_prefix || '%'
  GROUP BY sa.query
  ORDER BY frequency DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- 5. Indexes (non-blocking) ──────────────────────────────────────────────────────
-- If a previous attempt was interrupted, the index may exist as INVALID. IF NOT EXISTS
-- would then keep it, so the validation block below rejects INVALID indexes and
-- explains how to recover.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_search_vector_gin
  ON properties USING GIN (search_vector);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_location_gist
  ON properties USING GIST (location);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_properties_latitude_longitude
  ON properties (latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- 6. Batched backfill ────────────────────────────────────────────────────────────
-- Processes up to p_batch_size rows that still need search data and returns how many
-- it touched. Returns 0 once nothing remains. Each call is its own statement, so a
-- caller that loops over it commits progress as it goes and can resume after a crash.
-- FOR UPDATE SKIP LOCKED means rows locked by a live write are skipped, not waited on.
CREATE OR REPLACE FUNCTION backfill_search_batch(p_batch_size INTEGER DEFAULT 500)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH batch AS (
    SELECT id
    FROM properties
    WHERE search_vector IS NULL
       OR (location IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL)
    ORDER BY id
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE properties p
  -- Assigning a column to itself is enough: the UPDATE OF triggers fire and recompute.
  SET title = p.title,
      latitude = p.latitude
  FROM batch b
  WHERE p.id = b.id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- 7. Validation ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  missing TEXT[] := ARRAY[]::TEXT[];
  invalid TEXT[];
  obj TEXT;
BEGIN
  FOREACH obj IN ARRAY ARRAY['search_vector', 'latitude', 'longitude', 'location'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'properties' AND column_name = obj
    ) THEN
      missing := missing || ('properties.' || obj);
    END IF;
  END LOOP;

  FOREACH obj IN ARRAY ARRAY[
    'search_nearby_properties', 'search_properties_ranked',
    'get_search_suggestions', 'backfill_search_batch',
    'properties_location_update', 'properties_search_vector_update'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = obj AND pronamespace = current_schema()::regnamespace
    ) THEN
      missing := missing || ('function ' || obj);
    END IF;
  END LOOP;

  FOREACH obj IN ARRAY ARRAY['trg_properties_location_update', 'trg_properties_search_vector_update'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = obj) THEN
      missing := missing || ('trigger ' || obj);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'search_analytics'
  ) THEN
    missing := missing || 'table search_analytics';
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'Search rollout incomplete. Missing: %', array_to_string(missing, ', ');
  END IF;

  SELECT array_agg(c.relname::TEXT) INTO invalid
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relname IN (
    'idx_properties_search_vector_gin',
    'idx_properties_location_gist',
    'idx_properties_latitude_longitude'
  )
    AND NOT i.indisvalid;

  IF array_length(invalid, 1) > 0 THEN
    RAISE EXCEPTION
      'Invalid index left by an interrupted build: %. Run DROP INDEX CONCURRENTLY IF EXISTS <name> for each, then re-run 00067.',
      array_to_string(invalid, ', ');
  END IF;
END $$;
