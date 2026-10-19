-- Migration: 00030_add_support_cases.sql
-- Issue: #847 — Add support case linkage across bookings and messages
--
-- Creates a restricted support_cases table that links related entities
-- (bookings, messages, payments, disputes) by ID only — no full payload
-- duplication. Internal notes are excluded from customer-visible responses
-- at the application layer.
--
-- Access is scoped to authorised support/admin roles via RLS.

-- ── Enum types ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE support_case_status AS ENUM (
    'open',
    'in_progress',
    'awaiting_customer',
    'awaiting_staff',
    'resolved',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE support_case_priority AS ENUM ('low', 'normal', 'high', 'urgent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Main table ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS support_cases (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Reporter and assignee
  reporter_user_id  UUID          NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_to       UUID          REFERENCES auth.users(id) ON DELETE SET NULL,

  -- State machine
  status            support_case_status   NOT NULL DEFAULT 'open',
  priority          support_case_priority NOT NULL DEFAULT 'normal',

  -- Subject visible to the customer
  subject           TEXT          NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),

  -- Customer-visible status message (e.g. "We are investigating your case.")
  customer_status   TEXT          DEFAULT NULL CHECK (customer_status IS NULL OR length(customer_status) <= 1000),

  -- ── Linked entity IDs (by reference only — no data duplication) ──────────
  booking_id        UUID          REFERENCES bookings(id) ON DELETE SET NULL,
  message_id        UUID          REFERENCES messages(id) ON DELETE SET NULL,
  -- payment_id stored as text to support both internal UUIDs and on-chain IDs
  payment_ref       TEXT          DEFAULT NULL,
  -- dispute_id: references bookings in 'Disputed' status (no separate table yet)
  dispute_ref       TEXT          DEFAULT NULL,

  -- Timestamps
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ   DEFAULT NULL,
  closed_at         TIMESTAMPTZ   DEFAULT NULL
);

-- ── Internal notes (excluded from customer responses) ───────────────────────
-- Stored in a separate table so SELECT queries returning customer-visible
-- data can never accidentally include internal notes.

CREATE TABLE IF NOT EXISTS support_case_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID        NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  -- is_internal = TRUE → never surfaced to the customer
  is_internal BOOLEAN     NOT NULL DEFAULT TRUE,
  body        TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit trail ─────────────────────────────────────────────────────────────
-- Every state transition and sensitive lookup is recorded here.

CREATE TABLE IF NOT EXISTS support_case_audit (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID        NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  actor_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,   -- e.g. 'status_changed', 'note_added', 'record_accessed'
  -- reason is required for sensitive lookups (see application layer)
  reason      TEXT        DEFAULT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_support_cases_status
  ON support_cases (status);

CREATE INDEX IF NOT EXISTS idx_support_cases_reporter
  ON support_cases (reporter_user_id);

CREATE INDEX IF NOT EXISTS idx_support_cases_assigned
  ON support_cases (assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_booking
  ON support_cases (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_message
  ON support_cases (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_case_notes_case
  ON support_case_notes (case_id);

CREATE INDEX IF NOT EXISTS idx_support_case_audit_case
  ON support_case_audit (case_id);

-- ── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_support_case_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_support_cases_updated_at ON support_cases;
CREATE TRIGGER trg_support_cases_updated_at
  BEFORE UPDATE ON support_cases
  FOR EACH ROW EXECUTE FUNCTION set_support_case_updated_at();

-- ── Row-Level Security ───────────────────────────────────────────────────────
-- Customers can only see their own cases and only the non-internal notes.
-- Support/admin staff see all records (enforced via JWT role check at the
-- application layer — RLS here provides a defence-in-depth backstop).

ALTER TABLE support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_case_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_case_audit ENABLE ROW LEVEL SECURITY;

-- Customers: read their own cases only
CREATE POLICY support_cases_customer_read ON support_cases
  FOR SELECT
  USING (reporter_user_id = auth.uid());

-- Customers: create their own cases only
CREATE POLICY support_cases_customer_insert ON support_cases
  FOR INSERT
  WITH CHECK (reporter_user_id = auth.uid());

-- Customers: read non-internal notes on their own cases only
CREATE POLICY support_case_notes_customer_read ON support_case_notes
  FOR SELECT
  USING (
    is_internal = FALSE
    AND case_id IN (
      SELECT id FROM support_cases WHERE reporter_user_id = auth.uid()
    )
  );

-- No customer access to audit trail
CREATE POLICY support_case_audit_deny_customers ON support_case_audit
  FOR SELECT
  USING (FALSE);

-- ── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE support_cases IS
  'Restricted support case records. Links related entities by ID only. Internal notes stored separately. See issue #847.';

COMMENT ON TABLE support_case_notes IS
  'Notes on support cases. is_internal=TRUE rows must never be returned to customers.';

COMMENT ON TABLE support_case_audit IS
  'Immutable audit trail for all support case state changes and sensitive record lookups.';
