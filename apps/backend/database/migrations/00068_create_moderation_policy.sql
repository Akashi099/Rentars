-- Versioned moderation policy tables
--
-- Provides a single source of truth for content moderation rules:
--   - Which report reasons are supported (versioned taxonomy)
--   - How each reason maps to enforcement actions
--   - Appeal and retention rules per reason
--
-- Policy changes create a NEW version row; they never overwrite historical
-- decisions, which always reference the version that was in effect.

-- ─── Moderation policy versions ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS moderation_policy_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version         VARCHAR(30) NOT NULL UNIQUE,
  effective_date  DATE NOT NULL,
  -- Human-readable summary shown to users (not confidential)
  summary         TEXT NOT NULL,
  -- Full policy text or URL
  policy_url      TEXT,
  -- Appeal window in days (how long a user has to appeal a decision)
  appeal_window_days INTEGER NOT NULL DEFAULT 14 CHECK (appeal_window_days > 0),
  -- Retention period in days for moderation records (0 = keep forever)
  retention_days  INTEGER NOT NULL DEFAULT 0 CHECK (retention_days >= 0),
  is_active       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one active version at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_policy_active
  ON moderation_policy_versions (is_active)
  WHERE is_active = true;

-- ─── Moderation reason mappings ──────────────────────────────────────────────
--
-- Maps each report reason to the enforcement actions and visibility rules.
-- Multiple reasons can map to the same action; one reason can have multiple
-- actions (enforce + notify, for example).

CREATE TABLE IF NOT EXISTS moderation_reason_mappings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version_id UUID NOT NULL REFERENCES moderation_policy_versions(id) ON DELETE CASCADE,
  -- The reason code — must match REPORT_REASONS in report.service.ts
  reason_code     VARCHAR(50) NOT NULL,
  -- Human-readable label for UI display
  reason_label    VARCHAR(100) NOT NULL,
  -- Description of what this reason covers
  reason_description TEXT NOT NULL,
  -- Default enforcement action for this reason
  -- 'review'    — moderator must review before action
  -- 'hide'      — automatically hide the content pending review
  -- 'remove'    — automatically remove the content
  -- 'warn'      — send a warning to the content author
  -- 'ban'       — suspend the user account
  default_action  VARCHAR(20) NOT NULL CHECK (default_action IN (
    'review', 'hide', 'remove', 'warn', 'ban'
  )),
  -- Whether the reported user is notified
  notify_author   BOOLEAN NOT NULL DEFAULT true,
  -- Whether the reporter is notified of the outcome
  notify_reporter BOOLEAN NOT NULL DEFAULT true,
  -- Severity for triage (low/medium/high/critical)
  severity        VARCHAR(20) NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  -- Sort order for UI display
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (policy_version_id, reason_code)
);

CREATE INDEX IF NOT EXISTS idx_moderation_reason_mappings_version
  ON moderation_reason_mappings (policy_version_id, sort_order);

-- ─── Insert initial policy version (v1) ──────────────────────────────────────

INSERT INTO moderation_policy_versions (version, effective_date, summary, appeal_window_days, retention_days, is_active)
VALUES (
  '2026-10-16.1',
  '2026-10-16',
  'Rentars content moderation policy covering harassment, discrimination, fraud, unsafe properties, privacy violations, and retaliatory reviews. All reports are reviewed by trained moderators. Users may appeal decisions within 14 days.',
  14,
  365,
  true
)
ON CONFLICT (version) DO NOTHING;

-- ─── Insert reason mappings for v1 ───────────────────────────────────────────
-- Uses the existing report reason codes from the reports table CHECK constraint
-- (spam, fraud, inappropriate, misleading, harassment, other) plus expanded
-- codes for review-specific moderation.

INSERT INTO moderation_reason_mappings (policy_version_id, reason_code, reason_label, reason_description, default_action, notify_author, notify_reporter, severity, sort_order)
SELECT v.id, m.reason_code, m.reason_label, m.reason_description, m.default_action, m.notify_author, m.notify_reporter, m.severity, m.sort_order
FROM moderation_policy_versions v
CROSS JOIN (VALUES
  ('spam',          'Spam',              'Repetitive, irrelevant, or promotional content that does not contribute to the platform.', 'review', true, true, 'low', 1),
  ('fraud',         'Fraud',             'Misrepresentation, fake listings, stolen content, or attempts to deceive users for financial gain.', 'remove', true, true, 'critical', 2),
  ('inappropriate', 'Inappropriate Content', 'Offensive, explicit, or otherwise unsuitable content that violates community standards.', 'hide', true, true, 'high', 3),
  ('misleading',    'Misleading Information', 'False or deceptive claims about a property, amenities, or booking terms.', 'review', true, true, 'medium', 4),
  ('harassment',    'Harassment',        'Targeted attacks, threats, or sustained unwanted contact directed at an individual.', 'hide', true, true, 'high', 5),
  ('discrimination', 'Discrimination',   'Content or behavior that disparages individuals based on race, ethnicity, religion, gender, sexual orientation, or disability.', 'remove', true, true, 'critical', 6),
  ('unsafe_property','Unsafe Property',  'Reports of dangerous conditions, safety hazards, or properties that do not match safety claims.', 'hide', true, true, 'high', 7),
  ('privacy',       'Privacy Violation', 'Sharing of personal information, doxxing, or other breaches of user privacy.', 'remove', true, true, 'critical', 8),
  ('retaliatory',   'Retaliatory Review','A review that appears to be posted in retaliation for a dispute or negative review rather than reflecting a genuine experience.', 'review', true, true, 'medium', 9),
  ('other',         'Other',             'Reports that do not fit any specific category; reviewed case-by-case.', 'review', true, true, 'low', 10)
) AS m(reason_code, reason_label, reason_description, default_action, notify_author, notify_reporter, severity, sort_order)
WHERE v.version = '2026-10-16.1'
ON CONFLICT (policy_version_id, reason_code) DO NOTHING;

-- ─── Update reports table to support expanded reason codes ──────────────────
--
-- The existing CHECK constraint on reports.reason only allows:
--   spam, fraud, inappropriate, misleading, harassment, other
-- We add the new codes from the v1 policy (discrimination, unsafe_property,
-- privacy, retaliatory) while keeping the original ones.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'reports' AND c.conname = 'reports_reason_check'
  ) THEN
    ALTER TABLE reports DROP CONSTRAINT reports_reason_check;
  END IF;
END $$;

ALTER TABLE reports
  ADD CONSTRAINT reports_reason_check
    CHECK (reason IN (
      'spam', 'fraud', 'inappropriate', 'misleading', 'harassment',
      'discrimination', 'unsafe_property', 'privacy', 'retaliatory', 'other'
    ));
