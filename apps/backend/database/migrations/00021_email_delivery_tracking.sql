-- Migration 00021: Email delivery tracking
--
-- Adds three tables:
--   email_delivery_log  — one row per outbound send attempt; tracks provider
--                         message IDs, delivery outcomes, retries, and escalation
--                         path. Email content is NEVER stored here.
--   suppressed_emails   — permanent or temporary suppression list driven by
--                         hard bounces, spam complaints, and manual entries.
--   email_templates     — versioned template registry so operators can trace
--                         which template version was active for any incident.
--   email_webhook_events — replay-protection table for inbound provider webhooks.

-- ── email_delivery_log ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_delivery_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Recipient — stored as the hashed address so we don't index PII in the
  -- hot log table. The raw address lives in users.email and is joined on demand.
  recipient_hash      TEXT        NOT NULL,        -- SHA-256(lower(email))
  recipient_domain    TEXT        NOT NULL,        -- e.g. "gmail.com" for aggregation

  -- Template / content reference
  template_key        TEXT        NOT NULL,        -- e.g. "booking_confirmed"
  template_version    INTEGER     NOT NULL DEFAULT 1,

  -- Sending context
  notification_id     UUID        REFERENCES notifications(id) ON DELETE SET NULL,
  is_security_email   BOOLEAN     NOT NULL DEFAULT FALSE,  -- escalation path flag
  is_essential        BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Provider tracking
  provider_message_id TEXT,        -- set after successful handoff to SMTP/ESP
  provider_name       TEXT        NOT NULL DEFAULT 'smtp',

  -- Lifecycle
  status              TEXT        NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','delivered','bounced',
                                          'complaint','failed','suppressed')),
  attempt_count       INTEGER     NOT NULL DEFAULT 0,
  last_attempt_at     TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complaint_at        TIMESTAMPTZ,
  next_retry_at       TIMESTAMPTZ,

  -- Error detail (no content, no PII beyond what's already present)
  error_code          TEXT,
  error_message       TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edl_recipient_hash ON email_delivery_log (recipient_hash);
CREATE INDEX IF NOT EXISTS idx_edl_status         ON email_delivery_log (status);
CREATE INDEX IF NOT EXISTS idx_edl_template_key   ON email_delivery_log (template_key);
CREATE INDEX IF NOT EXISTS idx_edl_created_at     ON email_delivery_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_edl_provider_msg   ON email_delivery_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_email_delivery_log_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_edl_updated_at
  BEFORE UPDATE ON email_delivery_log
  FOR EACH ROW EXECUTE FUNCTION set_email_delivery_log_updated_at();

-- ── suppressed_emails ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS suppressed_emails (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- We store the hashed form as the lookup key and the original as the display
  -- value for admin tools. Both are set together; the hash is used for fast
  -- existence checks in the hot send path.
  email_hash      TEXT        NOT NULL UNIQUE,  -- SHA-256(lower(email))
  email_address   TEXT        NOT NULL,         -- lowercase canonical form

  reason          TEXT        NOT NULL
                    CHECK (reason IN ('hard_bounce','complaint','manual','unsubscribe')),
  source_log_id   UUID        REFERENCES email_delivery_log(id) ON DELETE SET NULL,

  -- Suppression scope
  suppress_all    BOOLEAN     NOT NULL DEFAULT TRUE,
  -- When suppress_all=FALSE, only the listed template keys are suppressed
  suppressed_templates  TEXT[],

  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL = permanent; non-null = auto-lift after this timestamp
  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_se_email_hash  ON suppressed_emails (email_hash);
CREATE INDEX IF NOT EXISTS idx_se_reason      ON suppressed_emails (reason);
CREATE INDEX IF NOT EXISTS idx_se_expires_at  ON suppressed_emails (expires_at)
  WHERE expires_at IS NOT NULL;

-- ── email_templates ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_templates (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key    TEXT        NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  subject_pattern TEXT        NOT NULL,      -- e.g. "Booking Confirmed — Rentars"
  description     TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  is_security     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (template_key, version)
);

CREATE INDEX IF NOT EXISTS idx_et_key_active ON email_templates (template_key, is_active);

-- Seed known templates
INSERT INTO email_templates (template_key, version, subject_pattern, description, is_security)
VALUES
  ('verification',              1, 'Verify your Rentars email',              'Account email verification',       TRUE),
  ('password_reset',            1, 'Reset your Rentars password',            'Password reset link',              TRUE),
  ('booking_created',           1, 'Booking Received — Rentars',             'Booking created notification',     FALSE),
  ('booking_confirmed',         1, 'Booking Confirmed by Host — Rentars',    'Booking confirmed notification',   FALSE),
  ('booking_cancelled',         1, 'Booking Cancelled — Rentars',            'Booking cancellation notification',FALSE),
  ('booking_detailed',          1, 'Booking Confirmed: {title} — Rentars',   'Detailed booking confirmation',    FALSE),
  ('host_booking_notification', 1, 'New Booking: {title} — Rentars',         'Host new booking notification',    FALSE)
ON CONFLICT (template_key, version) DO NOTHING;

-- ── email_webhook_events ──────────────────────────────────────────────────────
-- Replay-protection: every inbound webhook event is recorded here.
-- If the same event_id arrives twice the second delivery is a no-op.

CREATE TABLE IF NOT EXISTS email_webhook_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        TEXT        NOT NULL UNIQUE,   -- provider-supplied idempotency key
  provider        TEXT        NOT NULL DEFAULT 'smtp',
  event_type      TEXT        NOT NULL,          -- e.g. 'delivery', 'bounce', 'complaint'
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload     JSONB                          -- stored for audit; strip PII via policy
);

CREATE INDEX IF NOT EXISTS idx_ewe_event_id    ON email_webhook_events (event_id);
CREATE INDEX IF NOT EXISTS idx_ewe_processed   ON email_webhook_events (processed_at DESC);
