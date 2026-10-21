-- Payment integrity, atomic earnings entries, and recoverable escrow
-- reconciliation support for issues #767, #768, and #770.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_stroops NUMERIC(20, 0),
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USDC',
  ADD COLUMN IF NOT EXISTS quote_hash TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_event_hash TEXT,
  ADD COLUMN IF NOT EXISTS escrow_id TEXT;

UPDATE payments
SET amount_stroops = ROUND(amount_usdc * 10000000)
WHERE amount_stroops IS NULL;

ALTER TABLE payments
  ALTER COLUMN amount_stroops SET NOT NULL,
  ALTER COLUMN amount_usdc DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS payments_status_check,
  ADD CONSTRAINT payments_status_check
    CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'timed_out', 'refunded', 'under_review')),
  ADD CONSTRAINT payments_currency_check CHECK (currency = 'USDC'),
  ADD CONSTRAINT payments_amount_stroops_positive CHECK (amount_stroops > 0);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconcile_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconcile_error TEXT,
  ADD COLUMN IF NOT EXISTS escrow_failure_notified_at TIMESTAMPTZ;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check,
  ADD CONSTRAINT bookings_status_check CHECK (
    status IN (
      'Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed',
      'pending', 'confirmed', 'cancelled', 'completed', 'disputed',
      'escrow_reconcile_failed'
    )
  );

CREATE TABLE IF NOT EXISTS payment_callback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_callback_events_created
  ON payment_callback_events (created_at);

CREATE TABLE IF NOT EXISTS escrow_reconciliation_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  provider_event_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'manual_review')),
  error_category TEXT CHECK (error_category IN ('transient', 'permanent')),
  error_message TEXT,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT escrow_reconciliation_attempt_unique UNIQUE (booking_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_escrow_reconciliation_due
  ON escrow_reconciliation_attempts (next_retry_at)
  WHERE status = 'pending';

ALTER TABLE blockchain_logs
  ADD COLUMN IF NOT EXISTS error_category TEXT CHECK (error_category IN ('transient', 'permanent')),
  ADD COLUMN IF NOT EXISTS attempt INTEGER;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_idempotency
  ON notifications (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL,
  notification_type TEXT NOT NULL,
  data JSONB NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'suppressed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_outbox_recipient_dedupe_unique UNIQUE (recipient_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON notification_outbox (created_at)
  WHERE status = 'pending';

ALTER TABLE earnings_ledger_entries
  ALTER COLUMN amount TYPE NUMERIC(20, 7);

CREATE OR REPLACE FUNCTION record_booking_settlement(
  p_host_id UUID,
  p_booking_id UUID,
  p_gross_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_booking_host UUID;
  v_fee NUMERIC(20, 7);
BEGIN
  SELECT p.owner_id
  INTO v_booking_host
  FROM bookings b
  JOIN properties p ON p.id = b.property_id
  WHERE b.id = p_booking_id;

  IF v_booking_host IS NULL OR v_booking_host <> p_host_id THEN
    RAISE EXCEPTION 'Booking host does not match settlement host';
  END IF;

  IF p_gross_amount < 0 THEN
    RAISE EXCEPTION 'Settlement amount must be non-negative';
  END IF;

  v_fee := ROUND(p_gross_amount * 0.05, 7);

  INSERT INTO earnings_ledger_entries
    (host_id, booking_id, entry_type, direction, amount, currency, source_ref)
  VALUES
    (p_host_id, p_booking_id, 'booking_payment', 'credit', p_gross_amount, 'USDC',
      'booking_payment:' || p_booking_id::TEXT),
    (p_host_id, p_booking_id, 'platform_fee', 'debit', v_fee, 'USDC',
      'platform_fee:' || p_booking_id::TEXT)
  ON CONFLICT (host_id, source_ref) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION guard_confirmed_payment_amount()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_expected_stroops NUMERIC(20, 0);
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT ROUND(b.total_price * 10000000)
    INTO v_expected_stroops
    FROM bookings b
    WHERE b.id = NEW.booking_id;

    IF v_expected_stroops IS NULL OR NEW.amount_stroops <> v_expected_stroops THEN
      NEW.status := 'under_review';
      NEW.metadata := COALESCE(NEW.metadata, '{}'::JSONB) || JSONB_BUILD_OBJECT(
        'quarantine_reason', 'payment_amount_mismatch',
        'expected_stroops', v_expected_stroops,
        'actual_stroops', NEW.amount_stroops
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_confirmed_payment_amount ON payments;
CREATE TRIGGER trg_guard_confirmed_payment_amount
  BEFORE UPDATE OF status ON payments
  FOR EACH ROW
  EXECUTE FUNCTION guard_confirmed_payment_amount();

CREATE OR REPLACE FUNCTION record_confirmed_refund_debit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.refund_amount > 0
    AND EXISTS (
      SELECT 1
      FROM earnings_ledger_entries e
      WHERE e.host_id = NEW.host_id
        AND e.booking_id = NEW.booking_id
        AND e.entry_type = 'booking_payment'
        AND e.direction = 'credit'
    ) THEN
    INSERT INTO earnings_ledger_entries
      (host_id, booking_id, entry_type, direction, amount, currency, source_ref)
    VALUES
      (NEW.host_id, NEW.booking_id, 'refund_debit', 'debit', NEW.refund_amount,
        NEW.currency, 'refund_debit:' || NEW.id::TEXT)
    ON CONFLICT (host_id, source_ref) DO NOTHING;

    INSERT INTO notification_outbox
      (recipient_id, notification_type, data, dedupe_key)
    VALUES
      (NEW.tenant_id, 'booking_cancelled',
        JSONB_BUILD_OBJECT(
          'booking_id', NEW.booking_id,
          'refund_amount', NEW.refund_amount,
          'refund_tier', NEW.refund_tier,
          'refund_status', 'confirmed'
        ),
        'refund-confirmed:' || NEW.id::TEXT || ':tenant'),
      (NEW.host_id, 'booking_cancelled',
        JSONB_BUILD_OBJECT(
          'booking_id', NEW.booking_id,
          'refund_amount', NEW.refund_amount,
          'refund_tier', NEW.refund_tier,
          'refund_status', 'confirmed'
        ),
        'refund-confirmed:' || NEW.id::TEXT || ':host')
    ON CONFLICT (recipient_id, dedupe_key) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_record_confirmed_refund_debit ON refund_requests;
CREATE TRIGGER trg_record_confirmed_refund_debit
  AFTER UPDATE OF status ON refund_requests
  FOR EACH ROW
  EXECUTE FUNCTION record_confirmed_refund_debit();

-- Backfill confirmed payments so balances include settlements predating this
-- migration. Stable source references make repeated migration runs harmless.
SELECT record_booking_settlement(p.owner_id, b.id, pay.amount_stroops / 10000000)
FROM payments pay
JOIN bookings b ON b.id = pay.booking_id
JOIN properties p ON p.id = b.property_id
WHERE pay.status = 'confirmed'
  AND EXISTS (
    SELECT 1
    FROM blockchain_logs logs
    WHERE logs.booking_id = b.id::TEXT
      AND logs.on_chain_status = 'released'
  );
