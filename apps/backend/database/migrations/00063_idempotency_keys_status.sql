-- #599: Make booking creation idempotent — add status tracking to idempotency_keys.
--
-- Adds a `status` column so the service can distinguish between an in-progress
-- request (another concurrent call won the INSERT race) and a completed one
-- (safe to replay the stored response).
--
-- Values:
--   processing — the owning request inserted this record and is still executing.
--   completed  — the owning request finished; response_body holds the replay data.
--
-- Concurrent requests that find an existing 'processing' record can return 409
-- instead of silently creating a duplicate booking.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'completed';

-- Back-fill: all existing rows were inserted after the request completed.
UPDATE idempotency_keys SET status = 'completed' WHERE status IS NULL OR status = '';

-- Index to allow fast cleanup of stale processing records (e.g. from crashed requests).
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_status
  ON idempotency_keys(status)
  WHERE status = 'processing';
