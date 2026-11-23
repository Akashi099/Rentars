-- Migration: Add missing indexes for hot query patterns
-- 
-- Audit summary
-- =============
-- The following hot query patterns were identified across the service layer:
--
--   bookings:
--     - Filter by check_in / check_out (availability checks, date-range lookups)
--     - Filter by status (pending/confirmed/cancelled listings)
--     - Filter by property_id + status (owner dashboard)
--     - Filter by tenant_id + status (tenant booking history)
--
--   properties:
--     - Filter by status (available listings, featured)
--     - Filter by owner_id + status (host property management)
--     - Filter by price_per_night range (search)
--     - Filter by city/country (location search) — partial text; covered by tsvector for FTS
--
--   reviews:
--     - Filter by property_id + is_approved (show approved reviews only)
--     - Filter by is_flagged (moderation queue)
--
--   notifications:
--     - Filter by user_id + read = false (unread count badge)
--
--   availability_ranges:
--     - Filter by property_id + date range overlap (existing index covers property_id; add composite with dates)
--
--   search_analytics:
--     - Existing indexes (query, user_id) are sufficient.
--
-- Before/after: Run EXPLAIN (ANALYZE, BUFFERS) on representative queries to compare
-- sequential scans vs index scans. Typical improvement: seq scan O(N) → index scan O(log N).
--
-- Write performance note:
--   All indexes below are on low-write or append-only tables (notifications, bookings)
--   or on stable columns (status, check_in, property_id). The amenities GIN index
--   (00017) already handles array searches. We intentionally avoid over-indexing
--   high-write tables: avoid duplicating indexes already in place from earlier migrations.

-- ─── bookings ─────────────────────────────────────────────────────────────────

-- Composite: common query pattern — find confirmed/pending bookings for a property
-- Used by: calendar service, availability checks
CREATE INDEX IF NOT EXISTS idx_bookings_property_status
  ON bookings (property_id, status);

-- Composite: tenant booking history filtered by status
-- Used by: booking controller GET /bookings?tenant_id=X&status=Y
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status
  ON bookings (tenant_id, status);

-- Date range lookups — check-in/check-out are the most-filtered columns after property_id
-- Used by: checkAvailabilityAtomic, availability overlap queries
CREATE INDEX IF NOT EXISTS idx_bookings_check_in
  ON bookings (check_in);

CREATE INDEX IF NOT EXISTS idx_bookings_check_out
  ON bookings (check_out);

-- Composite covering date range + property (most selective combination)
-- Used by: "is the property available between X and Y?" queries
CREATE INDEX IF NOT EXISTS idx_bookings_property_dates
  ON bookings (property_id, check_in, check_out);

-- Composite: property + status + dates — supports the high-contention booking
-- stress scenario (concurrent availability checks on the same property) and
-- the owner dashboard, letting the planner satisfy status + range predicates
-- from a single index instead of bitmap-combining two indexes.
CREATE INDEX IF NOT EXISTS idx_bookings_property_status_dates
  ON bookings (property_id, status, check_in, check_out);

-- ─── properties ───────────────────────────────────────────────────────────────

-- Filter by status (available/draft/pending) — used heavily in search + featured listings
-- The existing idx_properties_owner_id covers owner-scoped lookups.
-- This covers the broader "all available properties" scan.
CREATE INDEX IF NOT EXISTS idx_properties_status
  ON properties (status);

-- Composite: owner's own properties by status (host dashboard)
CREATE INDEX IF NOT EXISTS idx_properties_owner_status
  ON properties (owner_id, status);

-- Price range filtering — used by search endpoint min_price/max_price params
CREATE INDEX IF NOT EXISTS idx_properties_price_per_night
  ON properties (price_per_night);

-- Full-text search vector — advanced search uses to_tsvector('english', title || description)
-- matched with @@ plainto_tsquery. Without this GIN index the search budget would
-- measure a sequential scan over the whole properties table.
CREATE INDEX IF NOT EXISTS idx_properties_search_vector
  ON properties
  USING GIN (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')));

-- Geospatial search — "near me" / bounding-box queries filter on latitude/longitude.
-- A GiST index over the point expression lets the planner do an index scan for
-- radius and bounding-box predicates instead of a full table scan.
CREATE INDEX IF NOT EXISTS idx_properties_geolocation
  ON properties
  USING GIST (point(longitude, latitude));

-- Composite: status + price — the most common advanced-search combination
-- (available listings within a price range), avoids a bitmap AND of two indexes.
CREATE INDEX IF NOT EXISTS idx_properties_status_price
  ON properties (status, price_per_night);

-- ─── reviews ──────────────────────────────────────────────────────────────────

-- Most review queries filter by property_id + is_approved to show public reviews.
-- idx_reviews_property_id already exists (00009); add composite with approval flag.
CREATE INDEX IF NOT EXISTS idx_reviews_property_approved
  ON reviews (property_id, is_approved);

-- Partial index for the moderation queue — only flagged rows, avoids scanning approved rows
CREATE INDEX IF NOT EXISTS idx_reviews_flagged
  ON reviews (property_id, created_at DESC)
  WHERE is_flagged = TRUE;

-- Booking-scoped reviews (single reviewer per booking constraint already exists)
-- idx_reviews_reviewer_id exists; add created_at for time-ordered queries
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_created
  ON reviews (reviewer_id, created_at DESC);

-- ─── notifications ────────────────────────────────────────────────────────────

-- The existing idx_notifications_read (user_id, read) covers the general case.
-- Add a partial index specifically for UNREAD notifications — this is the
-- highest-frequency query (unread count badge, notification list) and skips
-- the majority of rows once most notifications have been read.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications (user_id, created_at DESC)
  WHERE read = FALSE;

-- ─── availability_ranges ──────────────────────────────────────────────────────

-- idx_availability_ranges_dates already added in 00013_update_availability_ranges.sql
-- Add a covering index for is_available flag — callers typically filter available=true
CREATE INDEX IF NOT EXISTS idx_availability_ranges_available
  ON availability_ranges (property_id, start_date, end_date)
  WHERE is_available = TRUE;

-- ─── seasonal_pricing ─────────────────────────────────────────────────────────

-- idx_seasonal_pricing_property_id already created in 00014 (property_id, start, end).
-- No additional indexes needed; table is write-rarely / read-on-calendar-load.

-- ─── blockchain_logs ──────────────────────────────────────────────────────────

-- Existing indexes: idx_blockchain_logs_operation, idx_blockchain_logs_created_at
-- Add composite for operation + time window queries (audit log search)
CREATE INDEX IF NOT EXISTS idx_blockchain_logs_operation_time
  ON blockchain_logs (operation, created_at DESC);
