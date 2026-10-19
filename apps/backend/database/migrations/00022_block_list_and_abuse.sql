-- Migration 00022: Block list, abuse reports, and review response history
--
-- Adds:
--   user_blocks             — user-to-user blocking
--   abuse_reports           — unified abuse report table (messages, reviews,
--                             notifications) separate from property reports
--   review_response_history — edit history for host responses (immutable audit trail)

-- ── user_blocks ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_blocks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,                           -- optional; not surfaced to blocked user
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (blocker_id, blocked_id),
  CHECK  (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_ub_blocker ON user_blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_ub_blocked ON user_blocks (blocked_id);

-- ── abuse_reports ─────────────────────────────────────────────────────────────
-- Covers messaging, review, and notification abuse. Property/booking reports
-- already live in the reports table; this table handles content-level reports.

CREATE TABLE IF NOT EXISTS abuse_reports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Polymorphic target
  target_type     TEXT        NOT NULL
                    CHECK (target_type IN ('message','review','notification','user')),
  target_id       TEXT        NOT NULL,         -- UUID of the offending resource

  reason          TEXT        NOT NULL
                    CHECK (reason IN (
                      'spam','harassment','hate_speech','phishing',
                      'unsafe_link','impersonation','inappropriate_content','other'
                    )),
  detail          TEXT,                         -- max 1000 chars; enforced in app
  status          TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','under_review','resolved','dismissed')),
  resolved_by     UUID        REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ar_reporter    ON abuse_reports (reporter_id);
CREATE INDEX IF NOT EXISTS idx_ar_target      ON abuse_reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ar_status      ON abuse_reports (status);
CREATE INDEX IF NOT EXISTS idx_ar_created_at  ON abuse_reports (created_at DESC);

CREATE OR REPLACE FUNCTION set_abuse_report_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ar_updated_at
  BEFORE UPDATE ON abuse_reports
  FOR EACH ROW EXECUTE FUNCTION set_abuse_report_updated_at();

-- ── review_response_history ───────────────────────────────────────────────────
-- Every edit to host_response is appended here. The current live response
-- remains in reviews.host_response; this table is append-only for auditing.

CREATE TABLE IF NOT EXISTS review_response_history (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       UUID        NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author_id       UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  body            TEXT        NOT NULL,
  version         INTEGER     NOT NULL DEFAULT 1,
  -- Moderation state of this version
  moderation_status TEXT      NOT NULL DEFAULT 'pending'
                    CHECK (moderation_status IN ('pending','approved','rejected','removed')),
  moderation_note TEXT,
  moderated_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  moderated_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rrh_review_id ON review_response_history (review_id);
CREATE INDEX IF NOT EXISTS idx_rrh_author_id ON review_response_history (author_id);

-- ── reviews table additions ───────────────────────────────────────────────────
-- Add response edit window and version tracking columns to the existing table.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS host_response_version       INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS host_response_edit_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS host_response_mod_status    TEXT        DEFAULT NULL
    CHECK (host_response_mod_status IN ('pending','approved','rejected','removed'));

-- ── per-conversation daily message count ─────────────────────────────────────
-- A lightweight counter table so we can enforce per-conversation daily limits
-- without scanning the full messages table on every send.

CREATE TABLE IF NOT EXISTS message_daily_counts (
  -- Composite PK: (property_id, participant_a, participant_b, day)
  -- participant_a < participant_b to keep the row canonical regardless of who sends
  property_id     UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  participant_a   UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  participant_b   UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  day             DATE        NOT NULL DEFAULT CURRENT_DATE,
  message_count   INTEGER     NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (property_id, participant_a, participant_b, day),
  CHECK (participant_a < participant_b)
);

CREATE INDEX IF NOT EXISTS idx_mdc_day ON message_daily_counts (day);
