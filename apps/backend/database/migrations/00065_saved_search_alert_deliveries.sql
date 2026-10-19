-- Migration 00065: Saved-search alert delivery tracking (issue #751)
-- Records one row per (saved search, listing) so an alert is never sent twice
-- for the same listing, and tracks whether the notification was delivered.
-- Rows with status 'pending' are retried on a later matching run, which is how
-- alerts held back by quiet hours or the configured frequency are delivered.

CREATE TABLE IF NOT EXISTS saved_search_alert_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_search_id UUID NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT saved_search_alert_deliveries_search_property_key UNIQUE (saved_search_id, property_id)
);

-- Used to find the most recent successful alert for a search (frequency window).
CREATE INDEX IF NOT EXISTS idx_saved_search_alert_deliveries_search_sent
ON saved_search_alert_deliveries (saved_search_id, sent_at DESC)
WHERE status = 'sent';

-- Used to pick up deliveries still waiting for a frequency window or quiet hours.
CREATE INDEX IF NOT EXISTS idx_saved_search_alert_deliveries_pending
ON saved_search_alert_deliveries (saved_search_id)
WHERE status = 'pending';

ALTER TABLE saved_search_alert_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS saved_search_alert_deliveries_select_own ON saved_search_alert_deliveries;
CREATE POLICY saved_search_alert_deliveries_select_own ON saved_search_alert_deliveries
  FOR SELECT USING (auth.uid() = user_id);
