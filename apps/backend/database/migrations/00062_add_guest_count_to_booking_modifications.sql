-- Migration: 00062_add_guest_count_to_booking_modifications
-- Creates booking_modifications if it doesn't yet exist and adds guest-count
-- columns so modification requests can include an occupancy change that is
-- validated against property capacity before it is accepted.

CREATE TABLE IF NOT EXISTS booking_modifications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  requested_start  DATE,
  requested_end    DATE,
  original_start   DATE,
  original_end     DATE,
  status           VARCHAR(50) NOT NULL DEFAULT 'pending',
  requested_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_modifications_booking_id
  ON booking_modifications (booking_id);

-- Guest-count columns (added by this migration)
ALTER TABLE booking_modifications
  ADD COLUMN IF NOT EXISTS original_guest_count  INTEGER
    CHECK (original_guest_count  IS NULL OR original_guest_count  >= 1),
  ADD COLUMN IF NOT EXISTS requested_guest_count INTEGER
    CHECK (requested_guest_count IS NULL OR requested_guest_count >= 1);

COMMENT ON COLUMN booking_modifications.original_guest_count
  IS 'Guest count on the booking at the time the modification was requested.';
COMMENT ON COLUMN booking_modifications.requested_guest_count
  IS 'New guest count being requested; NULL means no occupancy change.';
