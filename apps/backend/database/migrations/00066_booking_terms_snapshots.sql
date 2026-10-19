-- #755: Freeze the listing terms a tenant agreed to on each booking.
--
-- Hosts may change price, rules, or capacity after a booking is made. The terms
-- captured here are the ones that applied when the tenant committed, and they are
-- never rewritten.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS listing_terms_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS listing_revision       INTEGER;

COMMENT ON COLUMN bookings.listing_terms_snapshot IS
  'Booking-relevant listing fields captured when the booking was created. Immutable once recorded.';

COMMENT ON COLUMN bookings.listing_revision IS
  'Listing revision number (property_versions.version_number) in effect when the booking was created.';

CREATE OR REPLACE FUNCTION prevent_booking_terms_snapshot_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.listing_terms_snapshot IS NOT NULL
     AND (NEW.listing_terms_snapshot IS DISTINCT FROM OLD.listing_terms_snapshot
          OR NEW.listing_revision    IS DISTINCT FROM OLD.listing_revision) THEN
    RAISE EXCEPTION 'listing terms snapshot is immutable once recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_booking_terms_snapshot_change ON bookings;
CREATE TRIGGER trg_prevent_booking_terms_snapshot_change
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION prevent_booking_terms_snapshot_change();
