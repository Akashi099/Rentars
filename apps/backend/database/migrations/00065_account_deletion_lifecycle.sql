-- Migration: Account export and deletion lifecycle (#744)
-- Purpose:
--   * data_exports: store the generated export payload so the user can fetch it
--     asynchronously. Payloads are cleared on expiry and on account deletion.
--   * account_deletions: record when the deletion was confirmed and when the
--     personal data was actually scrubbed, so completion is auditable without
--     retaining the personal data itself.

ALTER TABLE data_exports
  ADD COLUMN IF NOT EXISTS export_payload JSONB;

ALTER TABLE account_deletions
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS anonymised_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_blocked_reason TEXT;

-- Only one open deletion request per user at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_deletions_one_pending_per_user
  ON account_deletions(user_id)
  WHERE status = 'pending';

-- Worker lookup: pending requests whose cancellation window has elapsed.
CREATE INDEX IF NOT EXISTS idx_account_deletions_pending_due
  ON account_deletions(cancel_expires_at)
  WHERE status = 'pending';
