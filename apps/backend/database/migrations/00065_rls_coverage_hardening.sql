-- Migration: 00065_rls_coverage_hardening.sql
--
-- Closes RLS coverage gaps for sensitive tables that previously had RLS
-- disabled (or no explicit policy), so a leaked anon/authenticated key cannot
-- read or mutate data outside its authorization scope.
--
-- Policy model:
--   * Owner-scoped tables: clients may only touch rows they own (auth.uid()).
--   * Participant tables: clients may read/write only where they are a party.
--   * Server-managed tables: no client policy — effectively service-role only,
--     because the service role bypasses RLS and all legitimate access goes
--     through backend routes that enforce application-layer authorization.
--
-- Every policy is created with DROP POLICY IF EXISTS first so this migration
-- is idempotent and safe to re-run.

-- ─── users — own row only ────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS users_select_own ON users;
CREATE POLICY users_select_own ON users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- ─── messages — participants only ────────────────────────────────────────────
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_select_participant ON messages;
CREATE POLICY messages_select_participant ON messages
  FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = recipient_id);

DROP POLICY IF EXISTS messages_insert_sender ON messages;
CREATE POLICY messages_insert_sender ON messages
  FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- ─── reviews — authenticated read, author writes ────────────────────────────
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reviews_select_authenticated ON reviews;
CREATE POLICY reviews_select_authenticated ON reviews
  FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS reviews_insert_reviewer ON reviews;
CREATE POLICY reviews_insert_reviewer ON reviews
  FOR INSERT WITH CHECK (auth.uid() = reviewer_id);

DROP POLICY IF EXISTS reviews_update_reviewer ON reviews;
CREATE POLICY reviews_update_reviewer ON reviews
  FOR UPDATE USING (auth.uid() = reviewer_id) WITH CHECK (auth.uid() = reviewer_id);

DROP POLICY IF EXISTS reviews_delete_reviewer ON reviews;
CREATE POLICY reviews_delete_reviewer ON reviews
  FOR DELETE USING (auth.uid() = reviewer_id);

-- ─── reports — reporter owns their submissions ───────────────────────────────
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reports_select_reporter ON reports;
CREATE POLICY reports_select_reporter ON reports
  FOR SELECT USING (auth.uid() = reporter_id);

DROP POLICY IF EXISTS reports_insert_reporter ON reports;
CREATE POLICY reports_insert_reporter ON reports
  FOR INSERT WITH CHECK (auth.uid() = reporter_id);

-- ─── push_subscriptions — own only ───────────────────────────────────────────
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON push_subscriptions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_insert_own ON push_subscriptions;
CREATE POLICY push_subscriptions_insert_own ON push_subscriptions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_update_own ON push_subscriptions;
CREATE POLICY push_subscriptions_update_own ON push_subscriptions
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_delete_own ON push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON push_subscriptions
  FOR DELETE USING (auth.uid() = user_id);

-- ─── notification_preferences — own only ─────────────────────────────────────
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_preferences_own ON notification_preferences;
CREATE POLICY notification_preferences_own ON notification_preferences
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ─── account_deletions — requester sees own request ──────────────────────────
ALTER TABLE account_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_deletions_select_own ON account_deletions;
CREATE POLICY account_deletions_select_own ON account_deletions
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS account_deletions_insert_own ON account_deletions;
CREATE POLICY account_deletions_insert_own ON account_deletions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── data_exports — requester sees own export ────────────────────────────────
ALTER TABLE data_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_exports_select_own ON data_exports;
CREATE POLICY data_exports_select_own ON data_exports
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS data_exports_insert_own ON data_exports;
CREATE POLICY data_exports_insert_own ON data_exports
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ─── property_settings — property owner only ─────────────────────────────────
ALTER TABLE property_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_settings_owner ON property_settings;
CREATE POLICY property_settings_owner ON property_settings
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM properties p
    WHERE p.id = property_settings.property_id AND p.owner_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM properties p
    WHERE p.id = property_settings.property_id AND p.owner_id = auth.uid()
  ));

-- ─── property_versions — property owner may read; writes service-role only ───
ALTER TABLE property_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_versions_select_owner ON property_versions;
CREATE POLICY property_versions_select_owner ON property_versions
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM properties p
    WHERE p.id = property_versions.property_id AND p.owner_id = auth.uid()
  ));

-- ─── Server-managed sensitive tables — no client policy (service-role only) ──
-- RLS is enabled so anon/authenticated keys are denied by default. Backend
-- routes access these with the service role, which bypasses RLS, and enforce
-- their own authorization.
ALTER TABLE wallet_challenges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys      ENABLE ROW LEVEL SECURITY;
ALTER TABLE blockchain_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_modifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_reminders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_results         ENABLE ROW LEVEL SECURITY;

-- ─── Verification helper ─────────────────────────────────────────────────────
-- Lists any table in the public schema still missing RLS, so CI can fail fast
-- when a new sensitive table is added without a policy decision.
CREATE OR REPLACE VIEW rls_coverage_gaps AS
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relrowsecurity
ORDER BY c.relname;

COMMENT ON VIEW rls_coverage_gaps IS
  'Public tables with RLS disabled. A table appearing here has no explicit '
  'policy decision and must be reviewed before it stores sensitive data.';
