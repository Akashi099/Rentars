-- Notification enhancements: category filters, deep links, stable event IDs, retention
--
-- Adds:
--   category     — coarse bucket for filtering (booking, payment, review,
--                  dispute, message, system, etc.)
--   deep_link    — client-side route the app navigates to on tap
--   event_id     — stable identifier for dedup / idempotent delivery
--   expires_at   — optional retention cutoff; null = retain indefinitely
--
-- The category column is denormalised from `type` so the UI can group
-- notifications without mapping every individual type.  It is set at insert
-- time by the service layer and is never user-editable.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS category   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS deep_link  TEXT,
  ADD COLUMN IF NOT EXISTS event_id   VARCHAR(120),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Backfill category from existing type values.
-- Uses a CASE mapping that mirrors the categoryForType() function in
-- notification.service.ts.
UPDATE notifications SET category = CASE
  WHEN type IN ('booking_created','booking_confirmed','booking_cancelled',
                'booking_completed','booking_expired','booking_reminder',
                'booking_modification_requested','booking_modification_accepted',
                'booking_modification_declined') THEN 'booking'
  WHEN type = 'payment_received' THEN 'payment'
  WHEN type IN ('review_requested','review_submitted','host_response') THEN 'review'
  WHEN type IN ('dispute_initiated','booking_disputed') THEN 'dispute'
  WHEN type = 'message_received' THEN 'message'
  WHEN type = 'report_created' THEN 'moderation'
  WHEN type = 'new_property' THEN 'social'
  ELSE 'system'
END
WHERE category IS NULL;

-- Add CHECK constraint for valid categories.
ALTER TABLE notifications
  DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_category_check
    CHECK (category IS NULL OR category IN (
      'booking','payment','review','dispute','message','moderation','social','system'
    ));

-- Stable event ID: one event_id per user prevents duplicate notifications
-- for the same logical event (e.g. retried payment webhook).
-- Partial unique index — only applies when event_id is non-null so legacy
-- rows and event-less notifications are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_id_user
  ON notifications (user_id, event_id)
  WHERE event_id IS NOT NULL;

-- Category-filtered listing index.
CREATE INDEX IF NOT EXISTS idx_notifications_user_category_created
  ON notifications (user_id, category, created_at DESC);

-- Retention sweep index: find rows past their expiry.
CREATE INDEX IF NOT EXISTS idx_notifications_expires_at
  ON notifications (expires_at)
  WHERE expires_at IS NOT NULL;
