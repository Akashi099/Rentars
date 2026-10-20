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

-- #771 / #774: Payment idempotency context and attempt tracking.
--
-- Extends idempotency_keys with payment-specific context so the service can:
--   * retain the hash of a signed transaction (never the signed XDR itself) to
--     prevent resubmission of an already-signed payment;
--   * track the lifecycle of the underlying transaction independently of the
--     request `status` column (which keeps its existing semantics);
--   * count attempts per idempotency key / booking for attempt limits and
--     provider circuit breakers;
--   * record the last error category for recoverable failure UX.
--
-- transaction_status values:
--   pending    — no transaction submitted yet (or awaiting submission).
--   submitted  — signed transaction submitted to the provider; in flight.
--   confirmed  — transaction confirmed on-chain.
--   failed     — transaction definitively failed (safe to retry with new tx).
--   unknown    — outcome indeterminate (timeout); must reconcile, not resubmit.

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS signed_xdr_hash VARCHAR(128),
  ADD COLUMN IF NOT EXISTS transaction_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_category VARCHAR(64),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Back-fill: existing completed rows have no in-flight transaction.
UPDATE idempotency_keys
  SET transaction_status = 'pending'
  WHERE transaction_status IS NULL OR transaction_status = '';

-- Fast lookup of in-flight transactions for reconciliation and circuit breakers.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_transaction_status
  ON idempotency_keys(transaction_status)
  WHERE transaction_status IN ('submitted', 'unknown');

-- Fast lookup of payment attempts by booking reference for attempt limits.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_booking_ref
  ON idempotency_keys(booking_ref)
  WHERE booking_ref IS NOT NULL;

-- Prevent resubmission of the same signed transaction across idempotency keys.
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_signed_xdr_hash
  ON idempotency_keys(signed_xdr_hash)
  WHERE signed_xdr_hash IS NOT NULL;
</｜｜DSML｜｜ parameter>