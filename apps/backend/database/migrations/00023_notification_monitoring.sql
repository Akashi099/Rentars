-- Migration 00023: Notification monitoring & delivery metrics
--
-- Adds:
--   notification_delivery_log — one row per channel-send attempt; tracks queue
--                               age, latency, outcome, and retry state.
--   notification_channel_stats — pre-aggregated counters rolled up by hour,
--                                channel, and notification type for fast dashboard
--                                queries without scanning the raw log.

-- ── notification_delivery_log ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_delivery_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Foreign keys
  notification_id     UUID        REFERENCES notifications(id) ON DELETE SET NULL,
  user_id             UUID        REFERENCES users(id)         ON DELETE SET NULL,

  -- What we sent
  notification_type   TEXT        NOT NULL,
  channel             TEXT        NOT NULL
                        CHECK (channel IN ('in_app','email','push')),
  template_key        TEXT,

  -- Timing (all nullable — populated as the lifecycle progresses)
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,

  -- Latency convenience columns (ms); computed by application on update
  queue_latency_ms    INTEGER,   -- sent_at - enqueued_at
  delivery_latency_ms INTEGER,   -- delivered_at - sent_at

  -- Outcome
  status              TEXT        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','delivered','failed',
                                          'suppressed','skipped')),
  attempt_count       INTEGER     NOT NULL DEFAULT 0,
  last_error          TEXT,
  next_retry_at       TIMESTAMPTZ,

  -- Failure classification (aids dashboard grouping)
  failure_category    TEXT
                        CHECK (failure_category IN (
                          'provider_unavailable','rate_limited','invalid_token',
                          'suppressed','timeout','unknown'
                        )),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ndl_notification_id ON notification_delivery_log (notification_id)
  WHERE notification_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ndl_user_id         ON notification_delivery_log (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ndl_status          ON notification_delivery_log (status);
CREATE INDEX IF NOT EXISTS idx_ndl_channel_type    ON notification_delivery_log (channel, notification_type);
CREATE INDEX IF NOT EXISTS idx_ndl_enqueued_at     ON notification_delivery_log (enqueued_at DESC);
CREATE INDEX IF NOT EXISTS idx_ndl_next_retry      ON notification_delivery_log (next_retry_at)
  WHERE next_retry_at IS NOT NULL AND status = 'queued';

CREATE OR REPLACE FUNCTION set_ndl_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ndl_updated_at
  BEFORE UPDATE ON notification_delivery_log
  FOR EACH ROW EXECUTE FUNCTION set_ndl_updated_at();

-- ── notification_channel_stats ────────────────────────────────────────────────
-- Hourly rollup; the monitoring service upserts into this after each batch.
-- Querying this table is O(hours) not O(events), so dashboard queries stay fast
-- even at high notification volume.

CREATE TABLE IF NOT EXISTS notification_channel_stats (
  -- Composite PK: one row per (hour, channel, notification_type)
  hour_bucket         TIMESTAMPTZ NOT NULL,   -- truncated to hour: date_trunc('hour', ...)
  channel             TEXT        NOT NULL,
  notification_type   TEXT        NOT NULL,

  sent_count          INTEGER     NOT NULL DEFAULT 0,
  delivered_count     INTEGER     NOT NULL DEFAULT 0,
  failed_count        INTEGER     NOT NULL DEFAULT 0,
  suppressed_count    INTEGER     NOT NULL DEFAULT 0,
  retry_count         INTEGER     NOT NULL DEFAULT 0,

  -- Aggregated latencies (ms)
  avg_queue_latency_ms    NUMERIC(12,2),
  avg_delivery_latency_ms NUMERIC(12,2),
  p95_queue_latency_ms    INTEGER,

  -- Bounce rate for email channel (0.0 – 1.0)
  bounce_rate         NUMERIC(5,4),

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (hour_bucket, channel, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_ncs_hour_bucket ON notification_channel_stats (hour_bucket DESC);
CREATE INDEX IF NOT EXISTS idx_ncs_channel     ON notification_channel_stats (channel);
