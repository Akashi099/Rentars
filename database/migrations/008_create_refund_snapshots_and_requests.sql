-- Migration: 008_create_refund_snapshots_and_requests
-- Booking-time refund policy snapshots and idempotent refund requests (#769).
--
-- refund_policy_snapshots: captures the refund policy config at booking
--   creation time so later policy changes don't affect existing bookings.
-- refund_requests: tracks the full settlement lifecycle of a refund with
--   idempotent creation and a validated state machine.

CREATE TABLE IF NOT EXISTS refund_policy_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  -- JSONB: { fullRefundHours, noRefundHours, partialRefundPct }
  policy      JSONB NOT NULL,
  total_price NUMERIC(18, 2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refund_snapshots_booking
  ON refund_policy_snapshots (booking_id);

CREATE TABLE IF NOT EXISTS refund_requests (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  host_id               UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  refund_amount         NUMERIC(18, 2) NOT NULL CHECK (refund_amount >= 0),
  refund_tier           TEXT NOT NULL CHECK (refund_tier IN ('full', 'partial', 'none')),
  refund_policy_pct    NUMERIC(5, 4) NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'USDC',
  status                TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'submitted', 'confirmed', 'failed', 'manual_review')),
  idempotency_key       TEXT NOT NULL,
  destination_escrow_id TEXT,
  tx_hash               TEXT,
  snapshot_id           UUID NOT NULL REFERENCES refund_policy_snapshots(id),
  error_message         TEXT,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate refund requests for the same booking + idempotency key
  CONSTRAINT refund_requests_booking_idem_unique UNIQUE (booking_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_refund_requests_booking
  ON refund_requests (booking_id);

CREATE INDEX IF NOT EXISTS idx_refund_requests_status
  ON refund_requests (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_refund_requests_tenant
  ON refund_requests (tenant_id);
