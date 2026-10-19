-- Schema subset for the backup restore drill CI job (#736).
--
-- Mirrors the critical tables, extensions, and RLS policies from
-- apps/backend/database/migrations that the drill asserts. The full chain in
-- apps/backend/database/setup.sql does not yet apply to a fresh Supabase
-- database (00002_storage_and_rls.sql runs before profiles exists, and
-- 00013_add_property_search_vector.sql references a column added later), so
-- CI restores this subset. The scheduled drill (restore-drill.yml) restores the
-- real nonproduction schema.
--
-- This subset avoids the Supabase auth schema: payments reference users(id)
-- instead of auth.users, and policies read the caller from the JWT claim
-- setting instead of calling auth.uid(). That keeps it restorable into a plain
-- database created with CREATE DATABASE.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  location VARCHAR(255),
  price_per_night DECIMAL(10, 2) NOT NULL,
  max_guests INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  total_price DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdc     NUMERIC(20, 7) NOT NULL CHECK (amount_usdc > 0),
  stellar_tx_hash TEXT,
  status          TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'timed_out')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB,

  CONSTRAINT payments_booking_id_unique UNIQUE (booking_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  data JSONB DEFAULT '{}',
  read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NOT NULL,
  target_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read properties" ON properties
  FOR SELECT USING (true);

CREATE POLICY "Tenants can read their own bookings" ON bookings
  FOR SELECT USING (current_setting('request.jwt.claim.sub', true)::uuid = tenant_id);

CREATE POLICY "Tenants can read their own payments" ON payments
  FOR SELECT USING (current_setting('request.jwt.claim.sub', true)::uuid = tenant_id);

CREATE POLICY "Users can read their own notifications" ON notifications
  FOR SELECT USING (current_setting('request.jwt.claim.sub', true)::uuid = user_id);

CREATE POLICY "Actors can read their own audit records" ON audit_logs
  FOR SELECT USING (current_setting('request.jwt.claim.sub', true)::uuid = actor_id);
