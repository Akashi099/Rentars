# Active work items

This file tracks work that does not yet have a GitHub issue but is acknowledged
and in-flight.  Once an item has a GitHub issue, move it there and remove it here.

For the full product roadmap, scheduled milestones, and quarterly review process
see ROADMAP.md.

---

## #112 — Dispute resolution frontend

**Status:** Backend complete.  Frontend pending.
**Priority:** P1 — sprint blocker for Q4 mainnet launch.
**Owner:** *unassigned*

### Remaining work
- [x] Create `apps/web/src/components/booking/DisputeButton.tsx`
- [x] Create `apps/web/src/components/booking/DisputeModal.tsx`
- [x] Wire dispute-raise API call from modal (`POST /api/v1/bookings/:id/dispute`)
- [x] Show `DisputeButton` on active bookings (align with existing booking status logic)

### Already done
- [x] Backend: `dispute` and `dispute/resolve` service methods in `booking.service.ts`
- [x] Backend: notification types for both parties on raise/resolve
- [x] Backend: routes and validators for both endpoints
- [x] Architecture docs updated

---

## PostGIS migration deployment

**Status:** Migration file exists; not yet applied to the database.
**Priority:** P1 — geolocation search and search analytics table both blocked.
**Owner:** *unassigned*

### Steps
- [ ] Enable PostGIS extension: `CREATE EXTENSION postgis;`
- [ ] Apply `apps/backend/database/migrations/00014_search_analytics_and_geolocation.sql`
- [ ] Verify `search_nearby_properties()` and `get_search_suggestions()` functions exist
- [ ] Run backend search tests: `bun test tests/search.test.ts`

---

## Analytics opt-out API endpoint

**Status:** Service layer done (`analytics.service.ts`).  Route and controller pending.
**Priority:** P1 — required before mainnet launch (see LAUNCH_READINESS.md Section 7).
**Owner:** *unassigned*

### Remaining work
- [ ] Add `PATCH /api/v1/profile/analytics-preferences` route
- [ ] Controller calls `setAnalyticsOptOut(userId, optedOut)`
- [ ] Frontend: add opt-out toggle to profile/settings page
- [ ] Apply migration `00021_create_funnel_events.sql`

---

## Funnel event instrumentation

**Status:** Service and migration ready.  Call-site wiring pending.
**Priority:** P2 — analytics data collection cannot start until wired.
**Owner:** *unassigned*

### Call sites to wire up (backend)
- [ ] `booking.service.ts` — emit `booking.initiated` after INSERT
- [ ] `booking.service.ts` — emit `booking.confirmed` after status → confirmed
- [ ] `booking.service.ts` — emit `booking.cancelled` after status → cancelled
- [ ] `payment.service.ts` / escrow handlers — emit `payment.escrow_*` events
- [ ] `property.controller.ts` GET `:id` — emit `listing.viewed`
- [ ] `propertySearch.service.ts` `advancedSearch()` — emit `search.executed`
