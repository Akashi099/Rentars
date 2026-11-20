# Listing lifecycle: deletion, restoration and retention

This document is the policy reference for what happens to a property listing
after its owner removes it. It covers issue #923. Code references are given so
the rules can be checked against the implementation.

## Delete eligibility

`DELETE /api/v1/properties/:id` soft-deletes a listing
(`deleted_at` is set; the row is kept). Code: `deleteProperty` in
`src/services/property.service.ts`.

| Condition | Result |
| --- | --- |
| Caller is not the owner and not an `admin` | `403 Forbidden` |
| Listing does not exist | `404 Not Found` |
| Listing is already deleted | Success (idempotent) |
| A booking is `Pending`, `Confirmed` or `Disputed` and its check-out is today or later | `409` with `code: PROPERTY_HAS_ACTIVE_BOOKINGS` |
| Only `Completed`, `Cancelled`, `Expired` bookings, or past check-outs | Deleted |

The active-booking refusal is checked before the write and again after it. If a
booking is written in between, the tombstone is rolled back, so a guest is never
left with a reservation on a hidden listing.

Status sets are defined once in `src/utils/bookingStatus.ts`.

## What a deleted listing looks like

- **Public:** hidden from search, the by-slug and by-id public reads, featured
  results, the map, and quotes. Each of these filters on `deleted_at IS NULL`.
  Cache entries for the listing, including every featured-cap variant, are
  cleared on delete.
- **Owner and administrators:** the owner can still read the listing with
  `includeDeleted`. Administrators keep access for operational work.
- **Bookings and reviews:** existing bookings, payments and reviews still
  resolve through the stored `property_id`. New bookings are rejected.

## Restoration

There is **no self-service restore** for hosts. Deletion is a final host action
from the product's point of view.

Operational restore is possible only within the retention window (below). There
is no API endpoint for it. An engineer with database access clears `deleted_at`
for the row, and the change is recorded in the incident or support ticket. The
`property_versions` history is kept, so the listing content can be checked
before restoring. Adding a restore endpoint is a product decision and is not
part of this policy.

## Retention

- Soft-deleted listings are **purged after 180 days** (`RETENTION_SOFT_DELETED_PROPERTIES_DAYS`,
  see `src/services/retention.service.ts` and `docs/RETENTION_MATRIX.md`).
- A listing is **never purged while it has any booking row**, whatever the
  booking status. `bookings.property_id` is `ON DELETE RESTRICT`
  (migration `00071_booking_property_fk_restrict.sql`), so the database refuses
  a delete that would cascade into booking, payment or escrow history. The
  retention job skips such listings and reports them as held.
- Listings under a legal hold, or with a `Disputed` booking, are also skipped.

Known limitation: the purge fetches one batch of candidates per run. If more
than one batch of soft-deleted listings all have booking history, those
candidates can stall the batch until they are handled manually. This is
acceptable at current volumes and is recorded here so it is not forgotten.

## Slugs (#924)

- Format: `<title>-<city>-<6-char id prefix>`, lowercase ASCII, hyphen-separated.
  Accents are folded (`Café` becomes `cafe`). A title with no Latin letters uses
  the base `property`. A title with no letters or digits at all is rejected.
- Generated once, at creation, from the listing's own id. The id is chosen before
  the insert, so the row is written once with its slug. A slug collision (unique
  index) draws a new id and retries up to 3 times. It never leaves a listing
  without a slug.
- **Immutable.** Title and city edits do not change the slug, and a client-supplied
  `slug` is ignored. Migration `00072` enforces this in the database with a trigger
  that rejects changes to an existing slug, and a format CHECK for new rows. An
  old URL therefore keeps pointing at the same listing.
- Legacy numeric-id URLs (`/properties/:id`) keep resolving.
