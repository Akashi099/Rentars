-- Migration: 007_create_reconciliation_cases.sql
-- Created for issue #772: Build a restricted reconciliation operations view
--
-- This table stores mismatch records surfaced by the blockchain sync process
-- (sync.service.ts). Support staff and finance operators interact with it
-- via /api/v1/admin/reconciliation instead of directly editing bookings or
-- payment records.
--
-- Row-Level Security: all access must go through the backend service role.
-- Operators never connect directly to the database.

CREATE TABLE IF NOT EXISTS reconciliation_cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References — intentionally NOT foreign-key constrained so rows survive
  -- booking/payment deletion during incident investigation.
  booking_id          UUID        NOT NULL,
  payment_id          UUID,
  tenant_id           UUID        NOT NULL,
  property_id         UUID        NOT NULL,

  -- Current reconciliation status:
  --   pending    — queued for next reconciliation attempt
  --   mismatch   — on-chain state does not match DB (manual review needed)
  --   failed     — reconciliation exhausted retries
  --   escalated  — handed to a named team/person
  --   resolved   — manually or automatically closed
  status              TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'mismatch', 'failed', 'escalated', 'resolved')),

  -- On-chain references (safe to expose to operators)
  escrow_hash         TEXT,
  on_chain_id         BIGINT,

  -- Retry tracking
  reconcile_attempts  INTEGER     NOT NULL DEFAULT 0,
  last_reconcile_at   TIMESTAMPTZ,
  last_reconcile_error TEXT,

  -- Escalation fields
  escalated_reason    TEXT,
  escalated_to        TEXT,
  escalated_at        TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for common operator queries
CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_status
  ON reconciliation_cases (status);

CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_booking_id
  ON reconciliation_cases (booking_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_cases_created_at
  ON reconciliation_cases (created_at DESC);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION set_reconciliation_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconciliation_updated_at ON reconciliation_cases;
CREATE TRIGGER trg_reconciliation_updated_at
  BEFORE UPDATE ON reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION set_reconciliation_updated_at();

-- Row-Level Security: deny direct table access; backend uses service role.
ALTER TABLE reconciliation_cases ENABLE ROW LEVEL SECURITY;

-- Service role bypass (backend service has full access)
CREATE POLICY "service_role_full_access" ON reconciliation_cases
  USING (auth.role() = 'service_role');

COMMENT ON TABLE reconciliation_cases IS
  'Mismatch records for payment/escrow reconciliation. Operators interact via '
  '/api/v1/admin/reconciliation — never by direct table edit. '
  'Created for issue #772.';
