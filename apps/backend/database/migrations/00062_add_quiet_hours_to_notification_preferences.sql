-- Migration: 00062_add_quiet_hours_to_notification_preferences
-- Adds per-user quiet-hour window to notification_preferences so the reminder
-- scheduler can defer delivery when the recipient is in a do-not-disturb period.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS quiet_hours_start    TIME,
  ADD COLUMN IF NOT EXISTS quiet_hours_end      TIME,
  ADD COLUMN IF NOT EXISTS quiet_hours_timezone TEXT DEFAULT 'UTC';

COMMENT ON COLUMN notification_preferences.quiet_hours_start
  IS 'Wall-clock start of the quiet window (e.g. ''22:00''). NULL means no quiet window.';
COMMENT ON COLUMN notification_preferences.quiet_hours_end
  IS 'Wall-clock end of the quiet window (e.g. ''08:00''). May wrap past midnight.';
COMMENT ON COLUMN notification_preferences.quiet_hours_timezone
  IS 'IANA timezone used when evaluating the quiet window (default UTC).';
