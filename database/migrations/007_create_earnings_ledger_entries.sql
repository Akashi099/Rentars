-- Migration: 007_create_earnings_ledger_entries
-- Append-only ledger for host earnings (#770).
--
-- Every financial event (booking payment, escrow release, refund, platform fee,
-- manual adjustment) produces one immutable credit or debit entry.  Balances
-- are derived by summing entries; no mutable summary column is used.
--
-- Idempotency: (host_id, source_ref) UNIQUE ensures duplicate callbacks cannot
-- create duplicate entries.  Corrections append an `adjustment` row rather than
-- editing history.

CREATE TABLE IF NOT EXISTS earnings_ledger_entries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
  entry_type  TEXT NOT NULL CHECK (entry_type IN (
    'booking_payment', 'escrow_release', 'refund_debit', 'platform_fee', 'adjustment'
  )),
  direction   TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount      NUMERIC(18, 2) NOT NULL CHECK (amount >= 0),
  currency    TEXT NOT NULL DEFAULT 'USDC' CHECK (currency IN ('USDC')),
  -- Unique reference preventing duplicate entries from retried callbacks.
  -- Format: "<entry_type>:<entity_id>" or "adjustment:<admin_id>:<iso_ts>"
  source_ref  TEXT NOT NULL,
  admin_note  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate entries for the same host + source reference.
  CONSTRAINT earnings_ledger_host_source_unique UNIQUE (host_id, source_ref)
);

-- Index for balance queries filtered by host + period
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_host_period
  ON earnings_ledger_entries (host_id, created_at DESC);

-- Index for reconciliation by host + currency
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_host_currency
  ON earnings_ledger_entries (host_id, currency, created_at DESC);

-- Index for booking lookups
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_booking
  ON earnings_ledger_entries (booking_id);
