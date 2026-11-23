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
  ADD COLUMN IF NOT EXISTS rate_stale          BOOLEAN       DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS rate_source         VARCHAR(64)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rounding_mode       VARCHAR(16)   DEFAULT NULL;

-- Enforce per-currency precision limits on display_amount.
-- Currencies with zero minor units (e.g. JPY, KRW) must be whole numbers.
-- Currencies with three minor units (e.g. BHD, KWD) allow up to 3dp.
-- All other supported currencies allow up to 2dp.
-- display_amount is informational only; settlement uses USDC integer minor units.
ALTER TABLE bookings
  ADD CONSTRAINT chk_bookings_display_amount_precision
  CHECK (
    display_amount IS NULL
    OR (
      display_amount >= 0
      AND (
        (display_currency IN ('JPY', 'KRW') AND display_amount = TRUNC(display_amount))
        OR (display_currency IN ('BHD', 'KWD', 'OMR') AND display_amount = ROUND(display_amount, 3))
        OR (display_currency NOT IN ('JPY', 'KRW', 'BHD', 'KWD', 'OMR') AND display_amount = ROUND(display_amount, 2))
      )
    )
  );

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

COMMENT ON COLUMN bookings.rate_source IS
  'Identifier of the exchange-rate source/provider used for display_amount (e.g. provider name or feed id). Informational only — never used for settlement.';

COMMENT ON COLUMN bookings.rounding_mode IS
  'Rounding mode applied when converting to display_amount (e.g. HALF_UP, HALF_EVEN). Informational only — settlement amounts are computed in USDC integer minor units and never affected by display rounding.';
