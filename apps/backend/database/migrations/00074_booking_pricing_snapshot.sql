-- Migration 00074 (#926): store the accepted quote on each booking.
--
-- A booking keeps the nightly line items, the rules that set each price, and the
-- totals the tenant agreed to. The snapshot is written once, at creation, in the same
-- update as the listing-terms snapshot. Hosts can later see which rule affected a
-- date, even after they change the rules.
--
-- Immutable once recorded, like listing_terms_snapshot (migration 00066).

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS pricing_version  TEXT,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;

COMMENT ON COLUMN bookings.pricing_snapshot IS
  'Accepted price quote at booking creation: nightly prices, applied rules and totals. Immutable once recorded.';

CREATE OR REPLACE FUNCTION prevent_booking_pricing_snapshot_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.pricing_snapshot IS NOT NULL
     AND (NEW.pricing_snapshot IS DISTINCT FROM OLD.pricing_snapshot
          OR NEW.pricing_version IS DISTINCT FROM OLD.pricing_version) THEN
    RAISE EXCEPTION 'pricing snapshot is immutable once recorded';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_booking_pricing_snapshot_change ON bookings;
CREATE TRIGGER trg_prevent_booking_pricing_snapshot_change
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION prevent_booking_pricing_snapshot_change();
