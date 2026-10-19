-- #604: Centralize booking state machine and enrich status history
--
-- Adds from_status and reason columns so every history row captures the
-- full transition (predecessor state, actor, reason). Drops the auto-trigger
-- that previously wrote incomplete rows; the service layer now owns all
-- history insertions and validates each transition against the state machine.

ALTER TABLE booking_status_history
  ADD COLUMN IF NOT EXISTS from_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reason      TEXT;

-- Drop the auto-trigger — service layer owns validated history insertions.
DROP TRIGGER   IF EXISTS booking_status_change_trigger ON bookings;
DROP FUNCTION  IF EXISTS track_booking_status_change();
