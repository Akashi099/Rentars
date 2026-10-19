# RLS Policy Matrix

Every sensitive table must have an explicit policy decision. Tables accessed
directly by clients use least-privilege RLS policies; tables accessed only by
the backend run with RLS enabled and **no** client policy (service-role only,
since the service role bypasses RLS).

`rls_coverage_gaps` (view, migration `00065`) lists any public table still
missing RLS so CI can flag new tables without a decision.

## Roles

- **anon** — unauthenticated client.
- **authenticated** — signed-in user; `auth.uid()` is their user id.
- **service_role** — backend; bypasses RLS. All API routes enforce
  application-layer authorization before touching data.

## Matrix

| Table | RLS | Read | Write | Policy owner |
|---|---|---|---|---|
| profiles | ✅ | own-only | own-only | participant |
| users | ✅ | own row | own row | participant |
| bookings | ✅ | tenant + property owner | service-role-only | participant |
| payments | ✅ | service-role-only | service-role-only | financial |
| properties | ✅ | authenticated (available) | owner-only | participant |
| property_images | ✅ | authenticated | property owner | participant |
| property_settings | ✅ | property owner | property owner | participant |
| property_versions | ✅ | property owner | service-role-only | participant |
| wishlists | ✅ | own-only | own-only | participant |
| notifications | ✅ | own-only | own-only | participant |
| notification_preferences | ✅ | own-only | own-only | participant |
| push_subscriptions | ✅ | own-only | own-only | participant |
| messages | ✅ | sender/recipient | sender | participant |
| reviews | ✅ | authenticated | author | participant |
| reports | ✅ | reporter | reporter (insert) | participant |
| saved_searches | ✅ | own-only | own-only | participant |
| host_follows | ✅ | own-only | own-only | participant |
| availability_ranges | ✅ | property owner | property owner | participant |
| account_deletions | ✅ | own-only | own request | participant |
| data_exports | ✅ | own-only | own request | participant |
| legal_holds | ✅ | service-role-only | service-role-only | elevated |
| legal_hold_log | ✅ | service-role-only | service-role-only (append) | elevated |
| audit_logs | ✅ | service-role-only | service-role-only | elevated |
| blockchain_logs | ✅ | service-role-only | service-role-only | elevated |
| wallet_challenges | ✅ | service-role-only | service-role-only | elevated |
| password_reset_tokens | ✅ | service-role-only | service-role-only | elevated |
| idempotency_keys | ✅ | service-role-only | service-role-only | elevated |
| booking_modifications | ✅ | service-role-only | service-role-only | elevated |
| booking_reminders | ✅ | service-role-only | service-role-only | elevated |
| probe_results | ✅ | service-role-only | service-role-only | elevated |
| search_analytics / funnel_events | ✅ | service-role-only | service-role-only | elevated |

## Automated verification

`tests/rls/rls-policies.test.ts` exercises allowed **and** denied reads/writes
for anonymous, tenant, and host fixtures against a local Supabase stack. CI
runs it via the `rls-tests` job (`bun run test:rls`) and the job blocks the
pipeline on failure. Direct unauthorized access must fail; service-layer
authorization must agree with the policies for critical resources
(bookings, payments, properties).
