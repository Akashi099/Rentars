-- Enhanced review moderation workflow:
--   - Granular moderation states beyond pending/approved/rejected
--   - Appeal submission with deadline tracking
--   - Visibility rules (visible / hidden / removed) decoupled from moderation_status
--   - Immutable original content snapshots so moderation can never rewrite chain data
--   - Public-facing moderation explanation (separate from confidential moderator notes)
--   - Policy version + code tracking so decisions reference the policy in effect

ALTER TABLE reviews
  -- Granular moderation state — the existing moderation_status column
  -- (pending|approved|rejected) is kept for backwards compatibility; this
  -- new column tracks the full workflow lifecycle.
  ADD COLUMN IF NOT EXISTS moderation_state VARCHAR(25) NOT NULL DEFAULT 'none'
    CHECK (moderation_state IN (
      'none',            -- no moderation action taken
      'reported',        -- a report/flag has been filed
      'under_review',    -- a moderator is actively reviewing
      'action_taken',    -- moderator has taken action (hide/remove/keep)
      'appealed',        -- user has appealed the decision
      'resolved'         -- appeal resolved or action is final
    )),

  -- Visibility controls — decoupled from moderation_status so that a review
  -- can be hidden during investigation while keeping its original
  -- moderation_status intact.  'visible' is the default for all existing rows.
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(15) NOT NULL DEFAULT 'visible'
    CHECK (visibility IN ('visible', 'hidden', 'removed')),

  -- Immutable original content snapshots — set once when the review is
  -- first created and never updated.  This guarantees that even if a
  -- moderator changes the displayed comment/rating, the original chain-bound
  -- content is preserved.
  ADD COLUMN IF NOT EXISTS original_comment TEXT,
  ADD COLUMN IF NOT EXISTS original_rating   SMALLINT,

  -- Public-facing moderation explanation — shown to the reviewer and host.
  -- Must NOT contain confidential moderator notes (those go to audit_logs).
  ADD COLUMN IF NOT EXISTS moderation_explanation TEXT,

  -- Policy reference — the moderation policy version and reason code that
  -- the decision was based on.  Immutable once set.
  ADD COLUMN IF NOT EXISTS moderation_policy_version VARCHAR(30),
  ADD COLUMN IF NOT EXISTS moderation_policy_code     VARCHAR(50),

  -- Appeal tracking — appeal deadline, reason, and resolution.
  -- Default appeal window is 14 days from the moderation action.
  ADD COLUMN IF NOT EXISTS appeal_deadline   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS appeal_reason     TEXT,
  ADD COLUMN IF NOT EXISTS appeal_status     VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (appeal_status IN ('none', 'pending', 'approved', 'denied', 'expired')),
  ADD COLUMN IF NOT EXISTS appeal_decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS appeal_decided_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill original_comment and original_rating from existing data so that
-- legacy reviews have immutable snapshots too.
UPDATE reviews
  SET original_comment = comment,
      original_rating  = rating
WHERE original_comment IS NULL;

-- Backfill moderation_state for existing reviews based on current flags.
UPDATE reviews SET moderation_state = 'reported' WHERE is_flagged = true AND moderation_state = 'none';
UPDATE reviews SET moderation_state = 'resolved' WHERE moderation_status = 'approved' AND moderation_state = 'none' AND is_flagged = false;

-- Index for moderation-state queries (open queue, under_review, etc.)
CREATE INDEX IF NOT EXISTS idx_reviews_moderation_state
  ON reviews (moderation_state)
  WHERE moderation_state NOT IN ('none', 'resolved');

-- Index for visibility-filtered aggregate queries.
-- Used by recalculateAggregateFromVisibleReviews() to compute averages
-- excluding hidden/removed reviews.
CREATE INDEX IF NOT EXISTS idx_reviews_target_visibility
  ON reviews (target_id, visibility)
  WHERE visibility = 'visible';

-- Index for appeal queries (pending appeals).
CREATE INDEX IF NOT EXISTS idx_reviews_appeal_status
  ON reviews (appeal_status)
  WHERE appeal_status NOT IN ('none');
