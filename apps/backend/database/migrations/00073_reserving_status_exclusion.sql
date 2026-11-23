-- Migration 00073 (#925): the database must use the same reserving rule as the app.
--
-- A booking occupies dates when its status is one of:
--   Pending, Confirmed, Completed, Disputed
-- Cancelled and Expired bookings release their dates. The canonical list lives in
-- apps/backend/src/utils/bookingStatus.ts.
--
-- Migration 00062 excluded only Cancelled from the exclusion constraint, so an
-- Expired hold still blocked the same nights at the database level, even though
-- the booking RPC and the calendar both treated those nights as free. A guest
-- could see a free night and then get BOOKING_CONFLICT when booking it.
--
-- A Pending hold stops reserving once the expiry sweep marks it Expired. The
-- constraint cannot depend on the current time, so the sweep is the mechanism.
--
-- The exclusion constraint is replaced rather than edited in place. Existing
-- rows that were already valid under the old rule remain valid under the new
-- one, because the new predicate is a subset of the old.

-- (a) Ensure btree_gist is enabled so the exclusion constraint can combine
-- equality on property_id with range overlap on the date range.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- (b) Replace the exclusion constraint so its predicate exactly matches
-- RESERVING_BOOKING_STATUSES (Pending, Confirmed, Disputed, Completed).
-- Expired and Cancelled bookings release their dates.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_no_date_overlap;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_date_overlap
  EXCLUDE USING GIST (
    property_id                          WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  )
  WHERE (status IN ('Pending', 'Confirmed', 'Completed', 'Disputed'));

-- (c) Redefine create_booking_atomic_v2 so booking creation is serialized per
-- property via a transaction-scoped advisory lock, re-checks availability, and
-- translates exclusion violations into a stable BOOKING_CONFLICT error.
--
-- The advisory lock key is derived from the property id so that competing
-- requests for the same property serialize, while requests for different
-- properties proceed in parallel. The lock is released automatically at the end
-- of the transaction.
CREATE OR REPLACE FUNCTION create_booking_atomic_v2(
  p_property_id   uuid,
  p_tenant_id     uuid,
  p_check_in      date,
  p_check_out     date,
  p_total_amount  numeric,
  p_currency      text DEFAULT 'USD'
)
RETURNS bookings
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking bookings;
  v_lock_key bigint;
BEGIN
  IF p_check_in IS NULL OR p_check_out IS NULL OR p_check_in >= p_check_out THEN
    RAISE EXCEPTION 'INVALID_DATE_RANGE'
      USING ERRCODE = 'P0001';
  END IF;

  -- Derive a stable 64-bit advisory lock key from the property id.
  v_lock_key := ('x' || substr(md5(p_property_id::text), 1, 16))::bit(64)::bigint;

  -- Serialize competing booking attempts for this property.
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-check availability under the lock. availability_ranges already reflects
  -- the reserving statuses (Pending, Confirmed, Completed, Disputed).
  IF EXISTS (
    SELECT 1
    FROM availability_ranges ar
    WHERE ar.property_id = p_property_id
      AND daterange(ar.check_in, ar.check_out, '[)')
          && daterange(p_check_in, p_check_out, '[)')
  ) THEN
    RAISE EXCEPTION 'BOOKING_CONFLICT'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO bookings (
      property_id,
      tenant_id,
      check_in,
      check_out,
      total_amount,
      currency,
      status
    )
    VALUES (
      p_property_id,
      p_tenant_id,
      p_check_in,
      p_check_out,
      p_total_amount,
      p_currency,
      'Pending'
    )
    RETURNING * INTO v_booking;
  EXCEPTION
    WHEN exclusion_violation THEN
      -- The exclusion constraint fired despite the availability check (e.g. a
      -- concurrent insert that committed between the check and the insert).
      -- Surface a stable, non-disclosing conflict error.
      RAISE EXCEPTION 'BOOKING_CONFLICT'
        USING ERRCODE = 'P0001';
  END;

  RETURN v_booking;
END;
$$;

-- Helper to atomically expire stale Pending holds.
--
-- A Pending hold reserves dates until it is marked Expired. This function
-- transitions stale Pending bookings to Expired in a single transaction so that
-- the exclusion constraint (which only covers reserving statuses) releases the
-- dates atomically once the payment state is safely resolved.
--
-- A hold is considered stale when its payment has timed out: either the
-- payment_deadline has passed, or (when no deadline is set) the booking has
-- been Pending longer than the provided grace period.
CREATE OR REPLACE FUNCTION expire_stale_pending_bookings(
  p_grace_interval interval DEFAULT interval '15 minutes',
  p_now            timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_expired integer;
BEGIN
  WITH stale AS (
    UPDATE bookings b
       SET status = 'Expired',
           updated_at = p_now
     WHERE b.status = 'Pending'
       AND (
         (b.payment_deadline IS NOT NULL AND b.payment_deadline <= p_now)
         OR (b.payment_deadline IS NULL AND b.created_at <= p_now - p_grace_interval)
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_expired FROM stale;

  RETURN v_expired;
END;
$$;