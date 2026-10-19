-- #602: Booking modification with repricing and immutable snapshots
--
-- Creates the booking_modifications table (not previously migrated) and adds
-- repricing columns so every accepted modification records the original price,
-- the new price, the delta, and a snapshot of the booking before the change.

CREATE TABLE IF NOT EXISTS booking_modifications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID        NOT NULL REFERENCES bookings(id)  ON DELETE CASCADE,
  requested_by  UUID        NOT NULL REFERENCES profiles(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  requested_start DATE      NOT NULL,
  requested_end   DATE      NOT NULL,
  original_start  DATE      NOT NULL,
  original_end    DATE      NOT NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_modifications_booking_id
  ON booking_modifications (booking_id);

-- Repricing and snapshot columns
ALTER TABLE booking_modifications
  ADD COLUMN IF NOT EXISTS original_total_price      NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS new_total_price           NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS price_delta               NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS requires_additional_payment BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS booking_snapshot          JSONB;
