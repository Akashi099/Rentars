-- Sanitized seed data for the backup restore drill (#736).
--
-- Applied after schema.sql against a nonproduction database.
-- Contains only synthetic identities on the reserved .example domain, so the
-- drill can exercise references (payments -> bookings -> properties -> users)
-- and audit writes without touching real user data.

BEGIN;

INSERT INTO users (id, email, password_hash)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'tenant@drill.example', NULL),
  ('00000000-0000-4000-8000-000000000002', 'host@drill.example', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO properties (id, owner_id, title, location, price_per_night, max_guests)
VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000002',
   'Drill Sample Apartment', 'Testville', 120.00, 2)
ON CONFLICT (id) DO NOTHING;

INSERT INTO bookings (id, property_id, tenant_id, check_in, check_out, total_price, status)
VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101',
   '00000000-0000-4000-8000-000000000001', '2030-01-10', '2030-01-13', 360.00, 'Confirmed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO payments (id, booking_id, tenant_id, amount_usdc, status)
VALUES
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000201',
   '00000000-0000-4000-8000-000000000001', 360.0000000, 'confirmed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000002',
   'booking.confirm', 'booking', '00000000-0000-4000-8000-000000000201',
   '{"source": "restore-drill-seed"}')
ON CONFLICT (id) DO NOTHING;

COMMIT;
