#!/usr/bin/env bun
/**
 * Rentars local development seed script
 *
 * Populates the local Supabase database with a deterministic, realistic dataset:
 *   - 3 users (one host / two tenants)
 *   - 4 properties with varied price / location / amenities
 *   - Availability ranges for each property
 *   - 3 confirmed bookings (tenants → properties)
 *   - 2 approved reviews
 *   - Wishlist entries
 *   - Notifications
 *
 * Idempotent: uses upsert with stable UUIDs so it can be re-run safely without
 * creating duplicate rows.
 *
 * Usage:
 *   bun run apps/backend/database/seed.ts
 *   # or from the backend directory:
 *   cd apps/backend && bun run database/seed.ts
 *
 * Prerequisites:
 *   - Local Supabase stack running: `supabase start` or `docker-compose up`
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set (e.g. via .env.test)
 *
 * Environment:
 *   The script reads from .env.test by default in NODE_ENV=test, or .env otherwise.
 *
 * Performance / staging dataset:
 *   Set SEED_PROFILE=perf (or pass --profile=perf) to additionally generate a
 *   deterministic, reproducible staging dataset sized for k6 performance runs:
 *     - SEED_PERF_PROPERTIES (default 500) properties spread across several
 *       geospatial clusters with varied prices, cities, amenities and statuses
 *     - SEED_PERF_BOOKINGS (default 1000) bookings, with a configurable share
 *       (SEED_PERF_CONTENTION_SHARE, default 0.2) concentrated on a small set of
 *       "hot" properties to exercise high-contention booking paths
 *   All generated rows use stable, derived UUIDs so re-runs are idempotent and
 *   results are comparable across environments. The perf profile refuses to run
 *   against production targets (see guard below).
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

// ─── Load env ────────────────────────────────────────────────────────────────

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env.production'
    : process.env.NODE_ENV === 'test'
      ? '.env.test'
      : '.env';

dotenv.config({
  path: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', envFile),
});

// Fall back to .env if specialised file was empty / missing
dotenv.config({
  path: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.env'),
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    '❌  SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n' +
      `    Loaded env file: ${envFile}`,
  );
  process.exit(1);
}

// ─── Seed profile configuration ──────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const cliProfileArg = cliArgs.find((a) => a.startsWith('--profile='));
const SEED_PROFILE = (cliProfileArg?.split('=')[1] ?? process.env.SEED_PROFILE ?? 'dev').toLowerCase();
const IS_PERF_PROFILE = SEED_PROFILE === 'perf' || SEED_PROFILE === 'performance';

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const PERF_CONFIG = {
  properties: intFromEnv('SEED_PERF_PROPERTIES', 500),
  bookings: intFromEnv('SEED_PERF_BOOKINGS', 1000),
  contentionShare: Math.min(
    1,
    Math.max(0, Number.parseFloat(process.env.SEED_PERF_CONTENTION_SHARE ?? '0.2') || 0.2),
  ),
  // Number of "hot" properties that receive the contended bookings.
  hotProperties: Math.max(1, intFromEnv('SEED_PERF_HOT_PROPERTIES', 5)),
};

/**
 * Guard: the perf profile must never write to a production target.
 * Rejects when NODE_ENV=production, when the URL looks like a hosted
 * production project, or when the explicit opt-in flag is missing.
 */
function assertNonProductionTarget() {
  if (!IS_PERF_PROFILE) return;

  const allowOverride = process.env.SEED_PERF_ALLOW_NON_LOCAL === 'true';
  const url = (SUPABASE_URL ?? '').toLowerCase();
  const looksLocal =
    url.includes('localhost') ||
    url.includes('127.0.0.1') ||
    url.includes('0.0.0.0') ||
    url.includes('host.docker.internal') ||
    url.includes('supabase_kong') ||
    url.includes(':5432');

  if (process.env.NODE_ENV === 'production') {
    console.error('❌  Refusing to run the perf seed profile with NODE_ENV=production.');
    process.exit(1);
  }

  if (!looksLocal && !allowOverride) {
    console.error(
      '❌  Refusing to run the perf seed profile against a non-local Supabase target.\n' +
        `    SUPABASE_URL=${SUPABASE_URL}\n` +
        '    Set SEED_PERF_ALLOW_NON_LOCAL=true only for an isolated staging project.',
    );
    process.exit(1);
  }
}

assertNonProductionTarget();

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─── Stable seed IDs ─────────────────────────────────────────────────────────
// These IDs are fixed so the script is idempotent (re-run = upsert, not duplicate).

const IDS = {
  users: {
    host: '00000000-seed-0001-0000-000000000001',
    tenantA: '00000000-seed-0002-0000-000000000002',
    tenantB: '00000000-seed-0003-0000-000000000003',
  },
  properties: {
    beach: '00000000-seed-0010-0000-000000000010',
    mountain: '00000000-seed-0011-0000-000000000011',
    city: '00000000-seed-0012-0000-000000000012',
    countryside: '00000000-seed-0013-0000-000000000013',
  },
  bookings: {
    b1: '00000000-seed-0020-0000-000000000020',
    b2: '00000000-seed-0021-0000-000000000021',
    b3: '00000000-seed-0022-0000-000000000022',
  },
  reviews: {
    r1: '00000000-seed-0030-0000-000000000030',
    r2: '00000000-seed-0031-0000-000000000031',
  },
  wishlists: {
    w1: '00000000-seed-0040-0000-000000000040',
    w2: '00000000-seed-0041-0000-000000000041',
  },
  notifications: {
    n1: '00000000-seed-0050-0000-000000000050',
    n2: '00000000-seed-0051-0000-000000000051',
    n3: '00000000-seed-0052-0000-000000000052',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic pseudo-random generator (mulberry32) so the perf dataset is
 * byte-for-byte reproducible across environments and runs.
 */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a stable, valid UUID (v4-shaped) from a namespace + index. */
function stableUuid(namespace: string, index: number): string {
  const ns = namespace
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .padEnd(8, '0')
    .slice(0, 8);
  const idx = index.toString(16).padStart(12, '0');
  return `${ns}-0000-4000-8000-${idx}`;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function ok(label: string) {
  console.log(`  ✅  ${label}`);
}

function fail(label: string, error: unknown) {
  console.error(`  ❌  ${label}:`, error);
}

async function upsert(
  table: string,
  rows: Record<string, unknown>[],
  label: string,
  conflictColumn = 'id',
) {
  const { error } = await db.from(table).upsert(rows, { onConflict: conflictColumn });
  if (error) {
    fail(label, error.message);
  } else {
    ok(label);
  }
}

// ─── Seed functions ───────────────────────────────────────────────────────────

async function seedAuthUsers() {
  console.log('\n👤  Seeding auth users…');

  const users = [
    { id: IDS.users.host, email: 'seed-host@rentars-dev.local', password: 'SeedHost@Dev2024!' },
    { id: IDS.users.tenantA, email: 'seed-tenant-a@rentars-dev.local', password: 'SeedTenantA@Dev2024!' },
    { id: IDS.users.tenantB, email: 'seed-tenant-b@rentars-dev.local', password: 'SeedTenantB@Dev2024!' },
  ];

  for (const u of users) {
    // Check if user already exists
    const { data: existing } = await db.auth.admin.getUserById(u.id);
    if (existing?.user) {
      ok(`Auth user already exists: ${u.email}`);
      continue;
    }

    const { error } = await db.auth.admin.createUser({
      email: u.email,
      password: u.password,
      email_confirm: true,
      user_metadata: { id: u.id },
    });

    if (error) {
      fail(`Create auth user ${u.email}`, error.message);
    } else {
      ok(`Created auth user: ${u.email}`);
    }
  }
}

async function seedUsers() {
  console.log('\n📋  Seeding public.users…');
  await upsert(
    'users',
    [
      { id: IDS.users.host, email: 'seed-host@rentars-dev.local' },
      { id: IDS.users.tenantA, email: 'seed-tenant-a@rentars-dev.local' },
      { id: IDS.users.tenantB, email: 'seed-tenant-b@rentars-dev.local' },
    ],
    'users (3 rows)',
  );
}

async function seedProfiles() {
  console.log('\n🪪  Seeding profiles…');
  await upsert(
    'profiles',
    [
      {
        id: IDS.users.host,
        user_id: IDS.users.host,
        display_name: 'Alex Host',
        bio: 'Experienced host with 3 properties. Quick responder.',
        verified: true,
      },
      {
        id: IDS.users.tenantA,
        user_id: IDS.users.tenantA,
        display_name: 'Jordan Tenant',
        bio: 'Frequent traveler.',
        verified: false,
      },
      {
        id: IDS.users.tenantB,
        user_id: IDS.users.tenantB,
        display_name: 'Sam Traveler',
        bio: 'Digital nomad exploring the world.',
        verified: false,
      },
    ],
    'profiles (3 rows)',
  );
}

async function seedProperties() {
  console.log('\n🏠  Seeding properties…');
  await upsert(
    'properties',
    [
      {
        id: IDS.properties.beach,
        owner_id: IDS.users.host,
        title: 'Oceanfront Beach Bungalow',
        description:
          'Stunning oceanfront bungalow with private beach access. Perfect for couples and small families. Fully equipped kitchen, outdoor shower, and stunning sunset views.',
        price_per_night: 180,
        status: 'available',
        city: 'Miami',
        country: 'US',
        address: '101 Ocean Drive, Miami Beach, FL 33139',
        latitude: 25.7617,
        longitude: -80.1918,
        bedrooms: 2,
        bathrooms: 1,
        max_guests: 4,
        amenities: ['wifi', 'air_conditioning', 'kitchen', 'parking', 'pool'],
        images: [
          'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800',
          'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800',
        ],
        pets_allowed: false,
        smoking_allowed: false,
        events_allowed: false,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        additional_rules: 'No shoes inside. Rinse off at outdoor shower before entering.',
      },
      {
        id: IDS.properties.mountain,
        owner_id: IDS.users.host,
        title: 'Mountain Cabin Retreat',
        description:
          'Secluded log cabin nestled in the Rockies. Wood-burning fireplace, hot tub, and stunning mountain views. Ideal for hiking enthusiasts and those seeking peace.',
        price_per_night: 220,
        status: 'available',
        city: 'Aspen',
        country: 'US',
        address: '42 Pine Ridge Rd, Aspen, CO 81611',
        latitude: 39.1911,
        longitude: -106.8175,
        bedrooms: 3,
        bathrooms: 2,
        max_guests: 6,
        amenities: ['wifi', 'fireplace', 'hot_tub', 'kitchen', 'parking', 'washer_dryer'],
        images: [
          'https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800',
          'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800',
        ],
        pets_allowed: true,
        smoking_allowed: false,
        events_allowed: false,
        quiet_hours_start: '21:00',
        quiet_hours_end: '08:00',
        additional_rules: 'Pet fee: $50/stay. Please clean up after pets.',
      },
      {
        id: IDS.properties.city,
        owner_id: IDS.users.host,
        title: 'Modern Downtown Loft',
        description:
          'Sleek, modern loft in the heart of downtown. Walking distance to restaurants, galleries, and nightlife. High-speed WiFi, smart TV, and a fully stocked kitchen.',
        price_per_night: 130,
        status: 'available',
        city: 'New York',
        country: 'US',
        address: '500 W 25th St, New York, NY 10001',
        latitude: 40.7484,
        longitude: -74.0045,
        bedrooms: 1,
        bathrooms: 1,
        max_guests: 2,
        amenities: ['wifi', 'air_conditioning', 'kitchen', 'gym', 'elevator'],
        images: [
          'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800',
          'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800',
        ],
        pets_allowed: false,
        smoking_allowed: false,
        events_allowed: false,
        quiet_hours_start: '23:00',
        quiet_hours_end: '07:00',
        additional_rules: 'No parties. Guests only — no unregistered visitors overnight.',
      },
      {
        id: IDS.properties.countryside,
        owner_id: IDS.users.host,
        title: 'Charming Countryside Farmhouse',
        description:
          'Lovingly restored 19th-century farmhouse on 10 acres. Farm animals, vegetable garden, and open fire. The perfect rural escape with all modern comforts.',
        price_per_night: 95,
        status: 'available',
        city: 'Charlottesville',
        country: 'US',
        address: '888 Blue Ridge Farm Lane, Charlottesville, VA 22901',
        latitude: 38.0293,
        longitude: -78.4767,
        bedrooms: 4,
        bathrooms: 2,
        max_guests: 8,
        amenities: ['wifi', 'fireplace', 'kitchen', 'parking', 'garden', 'washer_dryer', 'bbq'],
        images: [
          'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=800',
          'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800',
        ],
        pets_allowed: true,
        smoking_allowed: true,
        events_allowed: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        additional_rules: 'Ideal for family gatherings. Max event size: 20 people. No amplified music after 22:00.',
      },
    ],
    'properties (4 rows)',
  );
}

async function seedAvailability() {
  console.log('\n📅  Seeding availability_ranges…');

  // Build availability windows: each property is available for the next 6 months
  const today = new Date();
  const sixMonths = new Date(today);
  sixMonths.setMonth(sixMonths.getMonth() + 6);

  const fmt = (d: Date) => d.toISOString().split('T')[0];

  const ranges = Object.values(IDS.properties).map((propertyId, i) => ({
    id: `00000000-seed-006${i}-0000-000000000060`,
    property_id: propertyId,
    start_date: fmt(today),
    end_date: fmt(sixMonths),
    is_available: true,
    reason: null,
  }));

  await upsert('availability_ranges', ranges, `availability_ranges (${ranges.length} rows)`);
}

async function seedBookings() {
  console.log('\n🛎  Seeding bookings…');
  await upsert(
    'bookings',
    [
      {
        id: IDS.bookings.b1,
        property_id: IDS.properties.beach,
        tenant_id: IDS.users.tenantA,
        check_in: '2025-09-01',
        check_out: '2025-09-07',
        total_price: 1080,
        guest_count: 2,
        status: 'Confirmed',
        rules_acknowledged_at: '2025-08-15T10:00:00Z',
      },
      {
        id: IDS.bookings.b2,
        property_id: IDS.properties.mountain,
        tenant_id: IDS.users.tenantB,
        check_in: '2025-12-20',
        check_out: '2025-12-27',
        total_price: 1540,
        guest_count: 4,
        status: 'Confirmed',
        rules_acknowledged_at: '2025-11-01T09:30:00Z',
      },
      {
        id: IDS.bookings.b3,
        property_id: IDS.properties.city,
        tenant_id: IDS.users.tenantA,
        check_in: '2025-11-10',
        check_out: '2025-11-13',
        total_price: 390,
        guest_count: 1,
        status: 'Pending',
        rules_acknowledged_at: '2025-10-20T14:00:00Z',
      },
    ],
    'bookings (3 rows)',
  );
}

async function seedReviews() {
  console.log('\n⭐  Seeding reviews…');
  await upsert(
    'reviews',
    [
      {
        id: IDS.reviews.r1,
        booking_id: IDS.bookings.b1,
        reviewer_id: IDS.users.tenantA,
        target_id: IDS.users.host,
        property_id: IDS.properties.beach,
        rating: 5,
        comment:
          'Absolutely stunning property! The beach access was incredible and Alex was a fantastic host. Would 100% stay again.',
        is_approved: true,
        is_flagged: false,
      },
      {
        id: IDS.reviews.r2,
        booking_id: IDS.bookings.b2,
        reviewer_id: IDS.users.tenantB,
        target_id: IDS.users.host,
        property_id: IDS.properties.mountain,
        rating: 4,
        comment:
          'Cozy cabin with amazing views. The hot tub was a highlight after a long hike. Minor issue with the WiFi speed, but otherwise perfect.',
        host_response:
          "Thanks so much for staying! We've since upgraded the WiFi — looking forward to your next visit.",
        host_response_at: '2025-12-30T12:00:00Z',
        is_approved: true,
        is_flagged: false,
      },
    ],
    'reviews (2 rows)',
  );
}

async function seedWishlists() {
  console.log('\n❤️   Seeding wishlists…');
  await upsert(
    'wishlists',
    [
      {
        id: IDS.wishlists.w1,
        user_id: IDS.users.tenantA,
        property_id: IDS.properties.mountain,
      },
      {
        id: IDS.wishlists.w2,
        user_id: IDS.users.tenantB,
        property_id: IDS.properties.countryside,
      },
    ],
    'wishlists (2 rows)',
  );
}

async function seedNotifications() {
  console.log('\n🔔  Seeding notifications…');
  await upsert(
    'notifications',
    [
      {
        id: IDS.notifications.n1,
        user_id: IDS.users.tenantA,
        type: 'booking_confirmed',
        data: { booking_id: IDS.bookings.b1, property_title: 'Oceanfront Beach Bungalow' },
        read: true,
      },
      {
        id: IDS.notifications.n2,
        user_id: IDS.users.tenantB,
        type: 'booking_confirmed',
        data: { booking_id: IDS.bookings.b2, property_title: 'Mountain Cabin Retreat' },
        read: false,
      },
      {
        id: IDS.notifications.n3,
        user_id: IDS.users.tenantA,
        type: 'booking_created',
        data: { booking_id: IDS.bookings.b3, property_title: 'Modern Downtown Loft' },
        read: false,
      },
    ],
    'notifications (3 rows)',
  );
}

// ─── Performance / staging dataset ───────────────────────────────────────────

// Geospatial clusters used to spread perf properties across regions so
// geospatial search filters (bounding box / radius) are representative.
const GEO_CLUSTERS = [
  { city: 'Miami', country: 'US', lat: 25.7617, lng: -80.1918 },
  { city: 'New York', country: 'US', lat: 40.7484, lng: -74.0045 },
  { city: 'Aspen', country: 'US', lat: 39.1911, lng: -106.8175 },
  { city: 'Charlottesville', country: 'US', lat: 38.0293, lng: -78.4767 },
  { city: 'Lisbon', country: 'PT', lat: 38.7223, lng: -9.1393 },
  { city: 'Barcelona', country: 'ES', lat: 41.3874, lng: 2.1686 },
  { city: 'Berlin', country: 'DE', lat: 52.52, lng: 13.405 },
  { city: 'Tokyo', country: 'JP', lat: 35.6762, lng: 139.6503 },
] as const;

const PERF_AMENITIES = [
  'wifi',
  'air_conditioning',
  'kitchen',
  'parking',
  'pool',
  'fireplace',
  'hot_tub',
  'gym',
  'washer_dryer',
  'garden',
  'bbq',
  'elevator',
] as const;

const PERF_STATUSES = ['available', 'available', 'available', 'unavailable', 'maintenance'] as const;

function perfPropertyId(i: number): string {
  return stableUuid('beef', i);
}

function perfBookingId(i: number): string {
  return stableUuid('b00c', i);
}

function perfAvailabilityId(i: number): string {
  return stableUuid('a711', i);
}

function buildPerfProperties() {
  const rng = createRng(0x5eed_0001);
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < PERF_CONFIG.properties; i++) {
    const cluster = GEO_CLUSTERS[i % GEO_CLUSTERS.length];
    // Jitter within ~0.5 degrees so radius/bbox filters return varied subsets.
    const lat = Number((cluster.lat + (rng() - 0.5)).toFixed(6));
    const lng = Number((cluster.lng + (rng() - 0.5)).toFixed(6));
    const price = 50 + Math.floor(rng() * 450);
    const bedrooms = 1 + Math.floor(rng() * 5);
    const bathrooms = 1 + Math.floor(rng() * 3);
    const maxGuests = bedrooms * 2;
    const amenityCount = 2 + Math.floor(rng() * 5);
    const amenities = Array.from(
      new Set(Array.from({ length: amenityCount }, () => pick(rng, PERF_AMENITIES))),
    );

    rows.push({
      id: perfPropertyId(i),
      owner_id: IDS.users.host,
      title: `Perf Property ${i} — ${cluster.city}`,
      description: `Deterministic perf dataset property #${i} in ${cluster.city}. Used for k6 search/booking benchmarks.`,
      price_per_night: price,
      status: pick(rng, PERF_STATUSES),
      city: cluster.city,
      country: cluster.country,
      address: `${100 + i} Perf Street, ${cluster.city}`,
      latitude: lat,
      longitude: lng,
      bedrooms,
      bathrooms,
      max_guests: maxGuests,
      amenities,
      images: [`https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800`],
      pets_allowed: rng() > 0.5,
      smoking_allowed: false,
      events_allowed: rng() > 0.8,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      additional_rules: 'Perf dataset row — not a real listing.',
    });
  }

  return rows;
}

function buildPerfAvailability() {
  const today = new Date();
  const sixMonths = new Date(today);
  sixMonths.setMonth(sixMonths.getMonth() + 6);
  const fmt = (d: Date) => d.toISOString().split('T')[0];

  return Array.from({ length: PERF_CONFIG.properties }, (_, i) => ({
    id: perfAvailabilityId(i),
    property_id: perfPropertyId(i),
    start_date: fmt(today),
    end_date: fmt(sixMonths),
    is_available: true,
    reason: null,
  }));
}

function buildPerfBookings() {
  const rng = createRng(0x5eed_0002);
  const tenants = [IDS.users.tenantA, IDS.users.tenantB];
  const rows: Record<string, unknown>[] = [];

  const contendedCount = Math.floor(PERF_CONFIG.bookings * PERF_CONFIG.contentionShare);

  for (let i = 0; i < PERF_CONFIG.bookings; i++) {
    // First `contendedCount` bookings target a small set of hot properties to
    // create realistic high-contention booking scenarios.
    const propertyIndex =
      i < contendedCount
        ? i % PERF_CONFIG.hotProperties
        : Math.floor(rng() * Math.max(1, PERF_CONFIG.properties));

    const checkInOffset = Math.floor(rng() * 180);
    const nights = 1 + Math.floor(rng() * 7);
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + checkInOffset);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + nights);
    const fmt = (d: Date) => d.toISOString().split('T')[0];

    rows.push({
      id: perfBookingId(i),
      property_id: perfPropertyId(propertyIndex),
      tenant_id: tenants[i % tenants.length],
      check_in: fmt(checkIn),
      check_out: fmt(checkOut),
      total_price: nights * (50 + Math.floor(rng() * 450)),
      guest_count: 1 + Math.floor(rng() * 4),
      status: i < contendedCount ? 'Pending' : pick(rng, ['Confirmed', 'Pending', 'Cancelled'] as const),
      rules_acknowledged_at: new Date().toISOString(),
    });
  }

  return rows;
}

async function seedPerfDataset() {
  console.log('\n⚡  Seeding performance dataset (profile=perf)…');
  console.log(
    `    properties=${PERF_CONFIG.properties} bookings=${PERF_CONFIG.bookings} ` +
      `contention_share=${PERF_CONFIG.contentionShare} hot_properties=${PERF_CONFIG.hotProperties}`,
  );

  const properties = buildPerfProperties();
  const availability = buildPerfAvailability();
  const bookings = buildPerfBookings();

  // Chunk large upserts to keep request payloads reasonable.
  const CHUNK = 500;
  for (let i = 0; i < properties.length; i += CHUNK) {
    await upsert(
      'properties',
      properties.slice(i, i + CHUNK),
      `perf properties (${i}–${Math.min(i + CHUNK, properties.length)})`,
    );
  }
  for (let i = 0; i < availability.length; i += CHUNK) {
    await upsert(
      'availability_ranges',
      availability.slice(i, i + CHUNK),
      `perf availability_ranges (${i}–${Math.min(i + CHUNK, availability.length)})`,
    );
  }
  for (let i = 0; i < bookings.length; i += CHUNK) {
    await upsert(
      'bookings',
      bookings.slice(i, i + CHUNK),
      `perf bookings (${i}–${Math.min(i + CHUNK, bookings.length)})`,
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱  Rentars — local seed script');
  console.log(`    Supabase URL: ${SUPABASE_URL}`);
  console.log('    Running upserts (idempotent — safe to re-run)…');

  await seedAuthUsers();
  await seedUsers();
  await seedProfiles();
  await seedProperties();
  await seedAvailability();
  await seedBookings();
  await seedReviews();
  await seedWishlists();
  await seedNotifications();

  if (IS_PERF_PROFILE) {
    await seedPerfDataset();
  }

  console.log('\n🎉  Seed complete!\n');
  if (IS_PERF_PROFILE) {
    console.log('    Performance dataset seeded (profile=perf).');
    console.log(
      `      properties=${PERF_CONFIG.properties} bookings=${PERF_CONFIG.bookings} ` +
        `contention_share=${PERF_CONFIG.contentionShare}`,
    );
    console.log('');
  }
  console.log('    Local credentials:');
  console.log('      Host:      seed-host@rentars-dev.local     / SeedHost@Dev2024!');
  console.log('      Tenant A:  seed-tenant-a@rentars-dev.local / SeedTenantA@Dev2024!');
  console.log('      Tenant B:  seed-tenant-b@rentars-dev.local / SeedTenantB@Dev2024!');
  console.log('');
}

main().catch((err) => {
  console.error('\nSeed script failed:', err);
  process.exit(1);
});
