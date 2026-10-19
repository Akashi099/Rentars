-- #600: Enforce transactional date availability at the database layer.
--
-- Adds a GiST exclusion constraint so that no INSERT or UPDATE can create
-- overlapping active bookings for the same property, regardless of which
-- code path performed the write.  The constraint is the authoritative
-- DB-level safety net; the advisory lock in create_booking_atomic_v2 remains
-- as a fast-fail before the INSERT.
--
-- Statuses that occupy a property's calendar:
--   Pending   — payment initiated, hold in effect
--   Confirmed — host accepted, payment cleared
--   Completed — stay finished (historical; date range is in the past)
--   Disputed  — under admin review; dates locked until resolution
--
-- Cancelled bookings release their dates immediately on status transition.

-- btree_gist is required to include a UUID column in a GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Exclusion constraint: no two non-cancelled bookings may share overlapping
-- dates for the same property.  daterange('[)') uses half-open intervals
-- matching the check_in < p_check_out AND check_out > p_check_in logic used
-- everywhere else in the codebase.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_date_overlap
  EXCLUDE USING GIST (
    property_id                          WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  )
  WHERE (status NOT IN ('Cancelled'));

-- Supersede create_booking_atomic_v2 (last updated in 00056) to:
--   1. Restore the per-property advisory lock that serialises concurrent
--      booking attempts and turns constraint violations into BOOKING_CONFLICT.
--   2. Explicitly enumerate active statuses instead of using NOT IN ('Cancelled')
--      so that any future status additions are deliberately opt-in.
--   3. Wrap the INSERT in an EXCEPTION block so that if the exclusion constraint
--      fires despite the advisory lock (e.g. direct write from a migration tool),
--      the caller still receives BOOKING_CONFLICT rather than a raw PG error.
CREATE OR REPLACE FUNCTION create_booking_atomic_v2(
  p_property_id           UUID,
  p_tenant_id             UUID,
  p_check_in              DATE,
  p_check_out             DATE,
  p_total_price           NUMERIC,
  p_guest_count           INTEGER,
  p_rules_acknowledged_at TIMESTAMPTZ DEFAULT NULL,
  p_terms_version         TEXT        DEFAULT NULL,
  p_terms_accepted_at     TIMESTAMPTZ DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id UUID;
BEGIN
  -- Per-property advisory lock: serialises all concurrent booking attempts
  -- so that at most one request per property passes the overlap check at a time.
  PERFORM pg_advisory_xact_lock(
    ('x' || substr(md5(p_property_id::text), 1, 16))::bit(64)::bigint
  );

  -- Reject if any active booking occupies the requested date range.
  -- Active statuses: Pending, Confirmed, Completed, Disputed.
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE property_id = p_property_id
      AND status IN ('Pending', 'Confirmed', 'Completed', 'Disputed')
      AND check_in  < p_check_out
      AND check_out > p_check_in
  ) THEN
    RAISE EXCEPTION 'BOOKING_CONFLICT: dates overlap with an existing booking';
  END IF;

  -- Reject if the host has manually blocked this date range.
  IF EXISTS (
    SELECT 1 FROM availability_ranges
    WHERE property_id = p_property_id
      AND is_available = FALSE
      AND start_date < p_check_out
      AND end_date   > p_check_in
  ) THEN
    RAISE EXCEPTION 'BOOKING_BLOCKED: dates are blocked by the host';
  END IF;

  BEGIN
    INSERT INTO bookings (
      property_id,
      tenant_id,
      check_in,
      check_out,
      total_price,
      guest_count,
      status,
      rules_acknowledged_at,
      terms_version,
      terms_accepted_at
    ) VALUES (
      p_property_id,
      p_tenant_id,
      p_check_in,
      p_check_out,
      p_total_price,
      p_guest_count,
      'Pending',
      p_rules_acknowledged_at,
      COALESCE(p_terms_version, 'pre-versioning'),
      COALESCE(p_terms_accepted_at, NOW())
    )
    RETURNING id INTO v_booking_id;
  EXCEPTION
    -- Exclusion constraint fires when the advisory-lock path is bypassed.
    -- Re-raise as BOOKING_CONFLICT so the application layer handles it uniformly.
    WHEN exclusion_violation THEN
      RAISE EXCEPTION 'BOOKING_CONFLICT: dates overlap with an existing booking';
  END;

  RETURN v_booking_id;
END;
$$;
