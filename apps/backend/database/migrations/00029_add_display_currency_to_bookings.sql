-- Migration: 00029_add_display_currency_to_bookings.sql
-- Issue: #841 — Define locale and currency support
--
-- Adds informational display-currency snapshot columns to bookings.
-- These columns record the currency the user had selected and the
-- converted amount at booking time for receipt/audit purposes.
--
-- IMPORTANT: These columns are NEVER used for settlement or escrow.
-- Settlement is always performed using `total_price` (USDC).
-- See: docs/I18N_CURRENCY_POLICY.md §9 Schema considerations

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS display_currency    VARCHAR(3)    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS display_amount      DECIMAL(14,4) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rate_timestamp_ms   BIGINT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rate_stale          BOOLEAN       DEFAULT FALSE;

-- Partial index: only rows that have a display currency set (keeps index small)
CREATE INDEX IF NOT EXISTS idx_bookings_display_currency
  ON bookings (display_currency)
  WHERE display_currency IS NOT NULL;

COMMENT ON COLUMN bookings.display_currency IS
  'ISO 4217 code of the display currency the user had selected at booking time. Informational only — never used for settlement.';

COMMENT ON COLUMN bookings.display_amount IS
  'Converted amount in display_currency at booking time. Informational only. 4dp to preserve precision across currencies like JPY vs BHD.';

COMMENT ON COLUMN bookings.rate_timestamp_ms IS
  'Unix milliseconds when the exchange rate used for display_amount was fetched. Stored for receipt and audit purposes.';

COMMENT ON COLUMN bookings.rate_stale IS
  'TRUE if the exchange rate was flagged stale at the time of conversion. When TRUE, receipts must show a staleness warning.';
