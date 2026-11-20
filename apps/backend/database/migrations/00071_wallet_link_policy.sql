-- Wallet account-linking policy (#914)
--
-- Challenges are now bound to a purpose (login, link, unlink), an optional user,
-- and the Stellar network they were issued for, so a signature for one action
-- cannot be replayed for another. Single-use and expiry still apply.
--
-- A wallet address may belong to at most one account. The partial unique index
-- allows many accounts without a wallet while preventing two accounts from
-- claiming the same address. If existing data already holds duplicates, the
-- index creation fails and those rows must be resolved before deploying.

ALTER TABLE wallet_challenges ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login';
ALTER TABLE wallet_challenges ADD COLUMN IF NOT EXISTS user_id UUID NULL;
ALTER TABLE wallet_challenges ADD COLUMN IF NOT EXISTS network TEXT NULL;

-- Challenge text is a 64-character hex nonce today; TEXT leaves room for richer
-- challenge formats without another migration.
ALTER TABLE wallet_challenges ALTER COLUMN challenge TYPE TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stellar_address_unique
  ON users(stellar_address)
  WHERE stellar_address IS NOT NULL;
