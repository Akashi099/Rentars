-- 00069_escrow_reconciliation_durability.sql (#877)
--
-- Adds durable attempt metadata for escrow reconciliation so retries survive
-- process restarts and ambiguous/permanent failures can be routed to manual
-- review distinct from a confirmed on-chain failure.
--
-- Forward-only, additive (nullable columns / safe default), idempotent via
-- IF NOT EXISTS so it is safe to re-run.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reconcile_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_last_error_class TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_provider_event_id TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_last_safe_state TEXT,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_manual_review_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS escrow_recovered_notified_at TIMESTAMPTZ;

-- Index to efficiently select only bookings whose backoff window has elapsed.
CREATE INDEX IF NOT EXISTS idx_bookings_reconcile_next_attempt
  ON bookings (reconcile_next_attempt_at)
  WHERE status = 'pending' AND escrow_hash IS NOT NULL;

COMMENT ON COLUMN bookings.reconcile_next_attempt_at IS
  'Earliest time the next reconciliation attempt may run (exponential backoff). #877';
COMMENT ON COLUMN bookings.reconcile_last_error_class IS
  'Last error classification observed: transient | ambiguous | permanent. #877';
COMMENT ON COLUMN bookings.reconcile_provider_event_id IS
  'Last blockchain/provider event id processed for this booking, for idempotent dedup. #877';
COMMENT ON COLUMN bookings.reconcile_last_safe_state IS
  'Last known-safe booking status before entering a failure/review path, used to recover cleanly. #877';
COMMENT ON COLUMN bookings.escrow_manual_review_at IS
  'Set when a booking is routed to manual review (ambiguous or exhausted-but-unconfirmed failures). #877';

-- ---------------------------------------------------------------------------
-- #949 / #993: durable escrow operation state machine + request correlation.
--
-- escrow_operations is keyed by (booking_id, operation_key) so a retried
-- create/release/refund always maps to the same durable operation record. The
-- request_fingerprint is persisted before external submission so a retry with a
-- different payload can be detected and rejected. Ambiguous outcomes stay
-- 'ambiguous' until reconciled against the provider.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS escrow_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  request_fingerprint TEXT NOT NULL,
  provider_reference TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  last_error_class TEXT,
  correlation_id TEXT,
  operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT escrow_operations_booking_operation_key_unique
    UNIQUE (booking_id, operation_key),
  CONSTRAINT escrow_operations_state_check
    CHECK (state IN ('pending', 'ambiguous', 'succeeded', 'failed')),
  CONSTRAINT escrow_operations_type_check
    CHECK (operation_type IN ('create', 'release', 'refund'))
);

-- Efficient selection of operations whose retry window has elapsed.
CREATE INDEX IF NOT EXISTS idx_escrow_operations_due_retry
  ON escrow_operations (next_retry_at)
  WHERE state IN ('pending', 'ambiguous');

-- Correlation lookups for support/operator tracing.
CREATE INDEX IF NOT EXISTS idx_escrow_operations_correlation_id
  ON escrow_operations (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_escrow_operations_operation_id
  ON escrow_operations (operation_id)
  WHERE operation_id IS NOT NULL;

COMMENT ON TABLE escrow_operations IS
  'Durable per-booking escrow operation state machine (create/release/refund). #949';
COMMENT ON COLUMN escrow_operations.operation_key IS
  'Stable idempotency key for the operation; unique per booking. #949';
COMMENT ON COLUMN escrow_operations.request_fingerprint IS
  'Hash of the request payload persisted before external submission to detect divergent retries. #949';
COMMENT ON COLUMN escrow_operations.state IS
  'pending | ambiguous | succeeded | failed. Ambiguous results stay pending verification. #949';
COMMENT ON COLUMN escrow_operations.provider_reference IS
  'Provider-side reference (e.g. escrow/tx id) used to reconcile ambiguous outcomes. #949';
COMMENT ON COLUMN escrow_operations.correlation_id IS
  'Request correlation id propagated from the originating API request. #993';
COMMENT ON COLUMN escrow_operations.operation_id IS
  'Operation id propagated through deferred work and provider calls. #993';

-- Correlation columns on blockchain_logs so worker/provider events can be
-- traced back to the originating request and booking.
ALTER TABLE blockchain_logs
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS booking_id UUID,
  ADD COLUMN IF NOT EXISTS operation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_blockchain_logs_correlation_id
  ON blockchain_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blockchain_logs_booking_id
  ON blockchain_logs (booking_id)
  WHERE booking_id IS NOT NULL;

COMMENT ON COLUMN blockchain_logs.correlation_id IS
  'Request correlation id for operator tracing across API and workers. #993';
COMMENT ON COLUMN blockchain_logs.booking_id IS
  'Booking this log entry relates to, for correlation lookups. #993';
COMMENT ON COLUMN blockchain_logs.operation_id IS
  'Operation id tying this log entry to a durable escrow operation. #993';

-- Correlation columns on idempotency_keys so deferred work can restore context.
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS booking_id UUID,
  ADD COLUMN IF NOT EXISTS operation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_correlation_id
  ON idempotency_keys (correlation_id)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_booking_id
  ON idempotency_keys (booking_id)
  WHERE booking_id IS NOT NULL;

COMMENT ON COLUMN idempotency_keys.correlation_id IS
  'Request correlation id persisted so deferred work can restore context. #993';
COMMENT ON COLUMN idempotency_keys.booking_id IS
  'Booking associated with the idempotent request, for correlation lookups. #993';
COMMENT ON COLUMN idempotency_keys.operation_id IS
  'Operation id associated with the idempotent request. #993';
