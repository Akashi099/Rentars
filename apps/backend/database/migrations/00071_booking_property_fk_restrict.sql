-- Migration 00071 (#923): stop listing deletion from cascading into bookings.
--
-- bookings.property_id was created with ON DELETE CASCADE. Hard-deleting a
-- property (for example, the retention purge of soft-deleted listings) would
-- silently remove every booking on it, including completed stays and their
-- payment and escrow history. The retention policy says those records are
-- never deleted, so the database must refuse the delete rather than cascade.
--
-- RESTRICT makes a property with any booking un-deletable at the row level.
-- The application layer (retention.service.ts) also skips such listings, so
-- the job reports them as held instead of failing.

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_property_id_fkey;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_property_id_fkey
  FOREIGN KEY (property_id)
  REFERENCES properties (id)
  ON DELETE RESTRICT;
