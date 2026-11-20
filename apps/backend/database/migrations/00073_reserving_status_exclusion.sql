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

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_no_date_overlap;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_date_overlap
  EXCLUDE USING GIST (
    property_id                          WITH =,
    daterange(check_in, check_out, '[)') WITH &&
  )
  WHERE (status IN ('Pending', 'Confirmed', 'Completed', 'Disputed'));
