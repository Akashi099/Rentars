-- Migration: align wallet_challenges with the wallet auth service (#746)
--
-- WalletAuthService reads and writes the column `address`, but migration 00004
-- created it as `stellar_address`. Every challenge insert would fail against a
-- schema built only from migrations.
--
-- The rename is conditional so environments that already have `address` are left
-- unchanged. Single-use enforcement relies on DELETE ... RETURNING, so no
-- additional column is needed.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'wallet_challenges'
      AND column_name = 'stellar_address'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'wallet_challenges'
      AND column_name = 'address'
  ) THEN
    ALTER TABLE wallet_challenges RENAME COLUMN stellar_address TO address;
  END IF;
END $$;

-- Lookups are always by (address, challenge) and filter on expiry.
CREATE INDEX IF NOT EXISTS idx_wallet_challenges_address_challenge
  ON wallet_challenges(address, challenge);
