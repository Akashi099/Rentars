-- #601: Booking expiration and payment timeout handling
--
-- Adds an indexed expires_at column so the cleanup scheduler can efficiently
-- find stale Pending bookings. Extends the status constraint to include the
-- terminal 'Expired' state.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Partial index — only Pending bookings can expire, so the index stays small.
CREATE INDEX IF NOT EXISTS idx_bookings_expires_at_pending
  ON bookings (expires_at)
  WHERE status = 'Pending';

-- Extend the status constraint to include the new terminal state.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
    CHECK (status IN (
      'Pending',
      'Confirmed',
      'Cancelled',
      'Completed',
      'Disputed',
      'Expired'
    ));
