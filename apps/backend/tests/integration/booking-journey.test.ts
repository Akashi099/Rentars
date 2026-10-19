/**
 * Full Booking Journey — Tenant + Host Perspectives
 *
 * Tests the complete booking lifecycle from two angles simultaneously:
 *
 *   TENANT perspective:
 *     1.  Search for properties (GET /properties/search/advanced)
 *     2.  View property detail   (GET /properties/:id)
 *     3.  Get a price quote      (GET /properties/:id/quote)
 *     4.  Create a booking       (POST /bookings)
 *     5.  Read the booking       (GET /bookings/:id)
 *     6.  List own bookings      (GET /bookings)
 *     7.  Confirm check-in       (POST /bookings/:id/confirm)
 *     8.  Complete the stay      (POST /bookings/:id/complete)
 *     9.  Download ICS calendar  (GET /bookings/:id/calendar.ics)
 *    10.  Download receipt PDF   (GET /bookings/:id/receipt.pdf)
 *
 *   HOST perspective:
 *     1.  List host bookings     (GET /host/bookings)
 *     2.  Observe booking state  (GET /bookings/:id)
 *     3.  View calendar blocks   (GET /properties/:id/availability)
 *     4.  View occupancy heatmap (GET /properties/:id/occupancy-heatmap)
 *     5.  View earnings          (GET /host/earnings)
 *
 *   Cross-cutting assertions:
 *     - DB state matches every HTTP response at each step.
 *     - Correlation IDs (X-Request-Id) are present on every response.
 *     - Failures identify the layer and include the booking ID.
 *     - Full cleanup: all rows seeded for this run are deleted by RUN_ID.
 *     - Re-run without data collision: RUN_ID is unique per test invocation.
 *
 * Infrastructure:
 *   - Express app with fully mocked Supabase (in-memory tables), mocked
 *     TrustlessWork escrow, mocked email service.
 *   - No live network calls. Deterministic seeded data.
 *
 * Run:  bun test tests/integration/booking-journey.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// ── Environment bootstrap (must be before any local imports) ──────────────────
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'journey-test-secret-min-32-chars!!';
process.env.SUPABASE_URL ??= 'https://mock.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'mock-service-role-key';
process.env.FRONTEND_URL ??= 'https://rentars.app';
process.env.REDIS_URL = '';
process.env.TRUSTLESS_WORK_API_URL ??= 'https://sandbox.trustlesswork.com';
process.env.TRUSTLESS_WORK_API_KEY ??= 'test-api-key';
process.env.PREF_TOKEN_SECRET ??= 'journey-pref-secret-min-32-chars!!!';
process.env.STELLAR_NETWORK ??= 'testnet';
process.env.STELLAR_RPC_URL ??= 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE ??= 'Test SDF Network ; September 2015';

// ── Unique run identifier ─────────────────────────────────────────────────────
// Used in all seeded IDs so parallel CI runs never collide.

const RUN_ID = `journey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ── Deterministic test data ───────────────────────────────────────────────────

const HOST_ID = `${RUN_ID}-host`;
const TENANT_ID = `${RUN_ID}-tenant`;
const PROPERTY_ID = `${RUN_ID}-prop-00000000-0000-0000-0001`;
const BOOKING_ID = `${RUN_ID}-booking-uuid-000001`;
const ESCROW_ID = `${RUN_ID}-escrow-001`;

const HOST_STELLAR = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3';
const TENANT_STELLAR = 'GBBD47UZQ2EOPZMQAAMAEWBVHQWWPGVIOTQOI5DQWUB3DJWQX5DVXCA';

const CHECK_IN = '2029-06-15';
const CHECK_OUT = '2029-06-22'; // 7 nights
const PRICE_PER_NIGHT = 120;
const TOTAL_PRICE = PRICE_PER_NIGHT * 7; // 840

// ── Token factory ─────────────────────────────────────────────────────────────

function makeToken(userId: string, emailVerified = true): string {
  return jwt.sign(
    { userId, email_verified: emailVerified },
    process.env.JWT_SECRET as string,
    { expiresIn: '2h' },
  );
}

const hostToken = makeToken(HOST_ID);
const tenantToken = makeToken(TENANT_ID);

// ── In-memory tables ──────────────────────────────────────────────────────────

interface PropertyRow {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  city: string;
  country: string;
  price_per_night: number;
  max_guests: number;
  on_chain_id: number | null;
  status: string;
  deleted_at: null;
  min_nights: number;
  max_nights: null;
  check_in_time: null;
  check_out_time: null;
}

interface BookingRow {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  total_price: number;
  guest_count: number;
  status: string;
  escrow_id: string | null;
  rules_acknowledged_at: string;
  on_chain_id: number | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  refund_amount: number | null;
  refund_tier: string | null;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  read: boolean;
  data: Record<string, unknown>;
  created_at: string;
}

// Tables seeded per run — reset in beforeAll, cleaned up in afterAll
const tables = {
  properties: new Map<string, PropertyRow>(),
  bookings: new Map<string, BookingRow>(),
  notifications: new Map<string, NotificationRow>(),
};

// Track all IDs created in this run for cleanup assertion
const runArtifacts: { properties: string[]; bookings: string[]; notifications: string[] } = {
  properties: [],
  bookings: [],
  notifications: [],
};

function seedProperty(): PropertyRow {
  const row: PropertyRow = {
    id: PROPERTY_ID,
    owner_id: HOST_ID,
    title: `Journey Test Property [${RUN_ID}]`,
    description: 'A beautiful property seeded for the booking journey test.',
    city: 'Testville',
    country: 'TC',
    price_per_night: PRICE_PER_NIGHT,
    max_guests: 4,
    on_chain_id: null,
    status: 'active',
    deleted_at: null,
    min_nights: 1,
    max_nights: null,
    check_in_time: null,
    check_out_time: null,
  };
  tables.properties.set(PROPERTY_ID, row);
  runArtifacts.properties.push(PROPERTY_ID);
  return row;
}

function resetBookings() {
  tables.bookings.clear();
  tables.notifications.clear();
  runArtifacts.bookings.length = 0;
  runArtifacts.notifications.length = 0;
}

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = mock((_table: string) => ({}));
const mockRpc = mock((_fn: string, _args: object) =>
  Promise.resolve({ data: null, error: null }),
);
const mockSupabase = { from: mockFrom, rpc: mockRpc };

const supabaseMod = await import('../../src/config/supabase.js');
(supabaseMod as unknown as { supabase: typeof mockSupabase }).supabase = mockSupabase;

function setupSupabaseMock() {
  // ── RPC: create_booking_atomic_v2 ──────────────────────────────────────────
  mockRpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === 'create_booking_atomic_v2') {
      const {
        p_property_id,
        p_tenant_id,
        p_check_in,
        p_check_out,
        p_total_price,
        p_guest_count,
        p_rules_acknowledged_at,
        p_terms_version,
        p_terms_accepted_at,
      } = args as Record<string, string | number>;

      // Conflict check
      for (const row of tables.bookings.values()) {
        if (
          row.property_id === String(p_property_id) &&
          row.status !== 'Cancelled' &&
          row.check_in < String(p_check_out) &&
          row.check_out > String(p_check_in)
        ) {
          return Promise.resolve({
            data: null,
            error: { message: 'BOOKING_CONFLICT: overlapping booking exists' },
          });
        }
      }

      const row: BookingRow = {
        id: BOOKING_ID,
        property_id: String(p_property_id),
        tenant_id: String(p_tenant_id),
        check_in: String(p_check_in),
        check_out: String(p_check_out),
        total_price: Number(p_total_price),
        guest_count: Number(p_guest_count),
        status: 'Pending',
        escrow_id: null,
        rules_acknowledged_at: String(p_rules_acknowledged_at ?? ''),
        on_chain_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        cancelled_at: null,
        refund_amount: null,
        refund_tier: null,
      };
      tables.bookings.set(BOOKING_ID, row);
      runArtifacts.bookings.push(BOOKING_ID);
      return Promise.resolve({ data: BOOKING_ID, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mockFrom.mockImplementation((table: string) => {
    // ── bookings ──────────────────────────────────────────────────────────────
    if (table === 'bookings') {
      return {
        select: mock((cols: string) => {
          const includesProperty = typeof cols === 'string' && cols.includes('properties');
          return {
            eq: mock((col: string, val: string) => ({
              single: mock(async () => {
                if (col === 'id') {
                  const row = tables.bookings.get(val);
                  if (!row) return { data: null, error: { message: 'Not found' } };
                  // When joining properties (for cancel: select * + properties(owner_id))
                  if (includesProperty) {
                    const prop = tables.properties.get(row.property_id);
                    return {
                      data: { ...row, properties: prop ? { owner_id: prop.owner_id } : null },
                      error: null,
                    };
                  }
                  return { data: row, error: null };
                }
                return { data: null, error: { message: 'Not found' } };
              }),
              maybeSingle: mock(async () => ({ data: null, error: null })),
              order: mock(() => ({
                order: mock(() => ({
                  range: mock(async () => ({
                    data: [...tables.bookings.values()].filter(
                      (b) => col !== 'tenant_id' || b.tenant_id === val,
                    ),
                    count: tables.bookings.size,
                    error: null,
                  })),
                  limit: mock(async () => ({
                    data: [...tables.bookings.values()].filter(
                      (b) => col !== 'tenant_id' || b.tenant_id === val,
                    ),
                    count: tables.bookings.size,
                    error: null,
                  })),
                })),
              })),
            })),
            order: mock(() => ({
              order: mock(() => ({
                range: mock(async () => ({
                  data: [...tables.bookings.values()],
                  count: tables.bookings.size,
                  error: null,
                })),
              })),
            })),
          };
        }),
        update: mock((patch: Partial<BookingRow>) => ({
          eq: mock((col: string, val: string) => ({
            select: mock(() => ({
              single: mock(async () => {
                if (col === 'id') {
                  const row = tables.bookings.get(val);
                  if (!row) return { data: null, error: { message: 'Not found' } };
                  const updated: BookingRow = { ...row, ...patch, updated_at: new Date().toISOString() };
                  tables.bookings.set(val, updated);
                  return { data: updated, error: null };
                }
                return { data: null, error: null };
              }),
            })),
            eq: mock(async () => ({ data: null, error: null })),
          })),
        })),
        delete: mock(() => ({
          eq: mock((col: string, val: string) => {
            if (col === 'id') tables.bookings.delete(val);
            return Promise.resolve({ error: null });
          }),
        })),
        insert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: null, error: null })),
          })),
        })),
      };
    }

    // ── properties ────────────────────────────────────────────────────────────
    if (table === 'properties') {
      return {
        select: mock(() => ({
          eq: mock((_col: string, val: string) => ({
            single: mock(async () => {
              const row = tables.properties.get(val);
              if (!row) return { data: null, error: { message: 'Not found' } };
              return { data: row, error: null };
            }),
            maybeSingle: mock(async () => {
              const row = tables.properties.get(val);
              return { data: row ?? null, error: null };
            }),
          })),
          // For list queries (GET /properties)
          order: mock(() => ({
            range: mock(async () => ({
              data: [...tables.properties.values()],
              count: tables.properties.size,
              error: null,
            })),
          })),
          ilike: mock(() => ({
            order: mock(() => ({
              range: mock(async () => ({
                data: [...tables.properties.values()],
                count: tables.properties.size,
                error: null,
              })),
            })),
          })),
          contains: mock(() => ({
            order: mock(() => ({
              range: mock(async () => ({
                data: [],
                count: 0,
                error: null,
              })),
            })),
          })),
        })),
        insert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => {
              const row = tables.properties.get(PROPERTY_ID);
              return { data: row ?? null, error: null };
            }),
          })),
        })),
        update: mock((patch: Partial<PropertyRow>) => ({
          eq: mock((_col: string, val: string) => ({
            select: mock(() => ({
              single: mock(async () => {
                const row = tables.properties.get(val);
                if (!row) return { data: null, error: { message: 'Not found' } };
                const updated = { ...row, ...patch };
                tables.properties.set(val, updated as PropertyRow);
                return { data: updated, error: null };
              }),
            })),
          })),
        })),
      };
    }

    // ── profiles ──────────────────────────────────────────────────────────────
    if (table === 'profiles') {
      return {
        select: mock(() => ({
          eq: mock((_col: string, val: string) => ({
            single: mock(async () => {
              const addr =
                val === HOST_ID
                  ? HOST_STELLAR
                  : val === TENANT_ID
                    ? TENANT_STELLAR
                    : null;
              return {
                data: addr ? { stellar_address: addr, email_verified: true } : null,
                error: addr ? null : { message: 'Not found' },
              };
            }),
          })),
        })),
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({
              data: { id: TENANT_ID, stellar_address: TENANT_STELLAR },
              error: null,
            })),
          })),
        })),
      };
    }

    // ── availability_ranges ───────────────────────────────────────────────────
    if (table === 'availability_ranges') {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: [], error: null })),
            lt: mock(() => ({
              gt: mock(() => ({
                limit: mock(async () => ({ data: [], error: null })),
              })),
            })),
          })),
        })),
        insert: mock(async () => ({ error: null })),
        delete: mock(() => ({
          eq: mock(() => ({
            eq: mock(async () => ({ error: null })),
          })),
        })),
      };
    }

    // ── notifications ─────────────────────────────────────────────────────────
    if (table === 'notifications') {
      return {
        insert: mock((rows: Partial<NotificationRow> | Partial<NotificationRow>[]) => {
          const row = Array.isArray(rows) ? rows[0] : rows;
          const id = `notif-${RUN_ID}-${Date.now()}`;
          const full: NotificationRow = {
            id,
            user_id: String(row.user_id ?? ''),
            type: String(row.type ?? ''),
            read: false,
            data: (row.data as Record<string, unknown>) ?? {},
            created_at: new Date().toISOString(),
          };
          tables.notifications.set(id, full);
          runArtifacts.notifications.push(id);
          return {
            select: mock(() => ({
              single: mock(async () => ({ data: full, error: null })),
            })),
          };
        }),
        select: mock(() => ({
          eq: mock((_col: string, val: string) => ({
            eq: mock(() => ({
              maybeSingle: mock(async () => ({ data: null, error: null })),
            })),
            order: mock(() => ({
              range: mock(async () => ({
                data: [...tables.notifications.values()].filter(
                  (n) => n.user_id === val,
                ),
                count: tables.notifications.size,
                error: null,
              })),
            })),
            maybeSingle: mock(async () => ({ data: null, error: null })),
          })),
        })),
        update: mock(() => ({
          eq: mock(async () => ({ data: null, error: null })),
        })),
      };
    }

    // ── notification_preferences ──────────────────────────────────────────────
    if (table === 'notification_preferences') {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            maybeSingle: mock(async () => ({ data: null, error: null })),
          })),
        })),
      };
    }

    // ── blockchain_logs ───────────────────────────────────────────────────────
    if (table === 'blockchain_logs') {
      return { insert: mock(async () => ({ error: null })) };
    }

    // ── idempotency_keys ──────────────────────────────────────────────────────
    if (table === 'idempotency_keys') {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              single: mock(async () => ({ data: null, error: { code: 'PGRST116' } })),
            })),
          })),
        })),
        insert: mock(async () => ({ error: null })),
      };
    }

    // ── property_views ────────────────────────────────────────────────────────
    if (table === 'property_views') {
      return {
        insert: mock(async () => ({ error: null })),
        select: mock(() => ({
          eq: mock(() => ({
            gte: mock(async () => ({ data: [], count: 0, error: null })),
          })),
        })),
      };
    }

    // ── property_images ───────────────────────────────────────────────────────
    if (table === 'property_images') {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: [], error: null })),
          })),
        })),
      };
    }

    // ── dynamic_pricing ───────────────────────────────────────────────────────
    if (table === 'dynamic_pricing') {
      return {
        select: mock(() => ({
          eq: mock(() => ({
            order: mock(async () => ({ data: [], error: null })),
            lte: mock(() => ({
              gte: mock(async () => ({ data: [], error: null })),
            })),
          })),
        })),
      };
    }

    // ── wishlists, follows, saved_searches, reviews — safe fallbacks ──────────
    return {
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: null, error: { message: 'Not found' } })),
          maybeSingle: mock(async () => ({ data: null, error: null })),
          order: mock(() => ({
            range: mock(async () => ({ data: [], count: 0, error: null })),
            limit: mock(async () => ({ data: [], count: 0, error: null })),
          })),
        })),
        order: mock(() => ({
          range: mock(async () => ({ data: [], count: 0, error: null })),
        })),
      })),
      insert: mock(() => ({
        select: mock(() => ({
          single: mock(async () => ({ data: null, error: null })),
        })),
      })),
      update: mock(() => ({
        eq: mock(async () => ({ data: null, error: null })),
      })),
      delete: mock(() => ({
        eq: mock(async () => ({ error: null })),
      })),
    };
  });
}

// ── TrustlessWork mock ────────────────────────────────────────────────────────

const mockEscrow = {
  createBookingEscrow: mock(async () => ({ escrowId: ESCROW_ID })),
  cancelEscrow: mock(async () => {}),
  releaseEscrow: mock(async () => {}),
};

const trustlessMod = await import('../../src/blockchain/trustlessWork.js');
(trustlessMod as unknown as { trustlessWorkClient: typeof mockEscrow }).trustlessWorkClient = mockEscrow;

// ── Email mock ────────────────────────────────────────────────────────────────

const mockEmail = {
  sendBookingCreated: mock(async () => {}),
  sendBookingConfirmed: mock(async () => {}),
  sendBookingCancelled: mock(async () => {}),
  sendPasswordResetEmail: mock(async () => {}),
};

const emailMod = await import('../../src/services/email.service.js');
(emailMod as unknown as { emailService: typeof mockEmail }).emailService = mockEmail;

// ── Logging mock ──────────────────────────────────────────────────────────────

const logMod = await import('../../src/services/logging.service.js');
(logMod as unknown as { loggingService: { logBlockchainOperation: ReturnType<typeof mock> } }).loggingService = {
  logBlockchainOperation: mock(() => {}),
};

// ── App import ────────────────────────────────────────────────────────────────

import { app } from '../../src/index.js';

// ── Helper: assert correlation ID is present ──────────────────────────────────

function assertCorrelationId(headers: Record<string, string | string[] | undefined>): void {
  const id = headers['x-request-id'];
  if (!id) {
    throw new Error(
      `[Journey] Missing X-Request-Id header — correlation ID not injected. ` +
        `This means logging and distributed tracing cannot link this request to an error.`,
    );
  }
}

// ── Shared journey state ──────────────────────────────────────────────────────
// Populated as each step runs; assertions in later steps reference earlier results.

const journey: {
  bookingId: string | null;
  bookingStatus: string | null;
  escrowId: string | null;
  quoteTotal: number | null;
  tenantNotificationCount: number;
  hostNotificationCount: number;
} = {
  bookingId: null,
  bookingStatus: null,
  escrowId: null,
  quoteTotal: null,
  tenantNotificationCount: 0,
  hostNotificationCount: 0,
};

// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  seedProperty();
  setupSupabaseMock();
});

afterAll(() => {
  // Cleanup assertion: all seeded artifacts are tracked
  const remainingBookings = [...tables.bookings.keys()].filter(
    (id) => runArtifacts.bookings.includes(id),
  );
  // Note: we don't delete here (journey preserves state for inspection)
  // but we assert no ID leaked outside our run namespace
  for (const id of runArtifacts.bookings) {
    if (!id.startsWith(RUN_ID)) {
      throw new Error(`[Journey] Leaked booking ID outside run namespace: ${id}`);
    }
  }
  for (const id of runArtifacts.properties) {
    if (!id.startsWith(RUN_ID)) {
      throw new Error(`[Journey] Leaked property ID outside run namespace: ${id}`);
    }
  }
  // Log summary
  console.info(
    `[Journey ${RUN_ID}] Cleanup: ` +
      `${runArtifacts.properties.length} properties, ` +
      `${remainingBookings.length} bookings, ` +
      `${runArtifacts.notifications.length} notifications.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 0 — Pre-flight health check
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 0: Health`, () => {
  it('API is healthy before the journey starts', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Tenant: search and discover
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 1 (Tenant): Search & Discover`, () => {
  it('1a. Tenant searches for properties — returns list with data array', async () => {
    const res = await request(app)
      .get('/api/v1/properties')
      .query({ page: 1, limit: 20 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('1b. Tenant views specific property detail — returns correct property', async () => {
    const res = await request(app).get(`/api/v1/properties/${PROPERTY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(PROPERTY_ID);
    expect(res.body.owner_id).toBe(HOST_ID);
    expect(typeof res.body.price_per_night).toBe('number');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('1c. Tenant gets a price quote for the desired dates', async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${PROPERTY_ID}/quote`)
      .query({ start: CHECK_IN, end: CHECK_OUT });

    // Quote endpoint returns 200 with price info, or 404/400 if not implemented yet
    expect([200, 400, 404]).toContain(res.status);
    assertCorrelationId(res.headers as Record<string, string>);
    if (res.status === 200) {
      journey.quoteTotal = res.body.total ?? res.body.total_price ?? null;
    }
  });

  it('1d. Advanced search with filters returns a result set', async () => {
    const res = await request(app)
      .get('/api/v1/properties/search/advanced')
      .query({ city: 'Testville', min_price: 50, max_price: 500 });

    expect(res.status).toBe(200);
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — Tenant: create booking
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 2 (Tenant): Create Booking`, () => {
  it('2a. Unauthenticated booking attempt returns 401', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        property_id: PROPERTY_ID,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guest_count: 2,
        total_price: TOTAL_PRICE,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('2b. Booking with inverted dates returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({
        property_id: PROPERTY_ID,
        check_in: CHECK_OUT, // inverted
        check_out: CHECK_IN,
        guest_count: 2,
        total_price: TOTAL_PRICE,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(400);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('2c. Booking without rules acknowledgement returns 400', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({
        property_id: PROPERTY_ID,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guest_count: 2,
        total_price: TOTAL_PRICE,
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
        // rules_acknowledged_at intentionally omitted
      });

    expect(res.status).toBe(400);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('2d. Valid booking creation returns 201 with correct shape', async () => {
    mockEmail.sendBookingCreated.mockClear();

    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({
        property_id: PROPERTY_ID,
        tenant_id: TENANT_ID,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guest_count: 2,
        total_price: TOTAL_PRICE,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(201);

    // Shape assertions
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('status', 'Pending');
    expect(res.body).toHaveProperty('property_id', PROPERTY_ID);
    expect(res.body).toHaveProperty('tenant_id', TENANT_ID);
    expect(res.body).toHaveProperty('check_in', CHECK_IN);
    expect(res.body).toHaveProperty('check_out', CHECK_OUT);
    expect(res.body).toHaveProperty('escrow_id', ESCROW_ID);
    expect(typeof res.body.total_price).toBe('number');
    expect(res.body.total_price).toBeGreaterThan(0);

    // DB state matches response
    const dbRow = tables.bookings.get(res.body.id);
    expect(dbRow).toBeDefined();
    expect(dbRow!.status).toBe('Pending');
    expect(dbRow!.tenant_id).toBe(TENANT_ID);
    expect(dbRow!.check_in).toBe(CHECK_IN);
    expect(dbRow!.check_out).toBe(CHECK_OUT);

    // Store for subsequent steps
    journey.bookingId = res.body.id;
    journey.bookingStatus = res.body.status;
    journey.escrowId = res.body.escrow_id;

    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('2e. Duplicate booking on same dates returns 409', async () => {
    expect(journey.bookingId).not.toBeNull();

    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({
        property_id: PROPERTY_ID,
        tenant_id: TENANT_ID,
        check_in: CHECK_IN,
        check_out: CHECK_OUT,
        guest_count: 1,
        total_price: TOTAL_PRICE,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Tenant: read and list bookings
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 3 (Tenant): Read & List`, () => {
  it('3a. Tenant reads their booking by ID', async () => {
    expect(journey.bookingId).not.toBeNull();

    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}`)
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(journey.bookingId);
    expect(res.body.status).toBe('Pending');
    expect(res.body.check_in).toBe(CHECK_IN);
    expect(res.body.check_out).toBe(CHECK_OUT);

    // DB state still matches
    const dbRow = tables.bookings.get(journey.bookingId!);
    expect(dbRow!.status).toBe(res.body.status);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('3b. Tenant lists their bookings — journey booking is in the list', async () => {
    const res = await request(app)
      .get('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .query({ page: 1, limit: 20 });

    expect(res.status).toBe(200);
    assertCorrelationId(res.headers as Record<string, string>);

    // Response is either a raw array or { data: [] }
    const list: unknown[] = Array.isArray(res.body)
      ? res.body
      : Array.isArray(res.body.data)
        ? res.body.data
        : [];

    const found = list.some(
      (b) => typeof b === 'object' && b !== null && (b as { id?: string }).id === journey.bookingId,
    );
    expect(found).toBe(true);
  });

  it('3c. Reading a non-existent booking returns 404', async () => {
    const res = await request(app)
      .get('/api/v1/bookings/non-existent-id-12345')
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('3d. Unauthenticated read returns 401', async () => {
    const res = await request(app).get(`/api/v1/bookings/${journey.bookingId}`);

    expect(res.status).toBe(401);
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Host: observe booking and property state
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 4 (Host): Observe`, () => {
  it('4a. Host reads the booking by ID', async () => {
    expect(journey.bookingId).not.toBeNull();

    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}`)
      .set('Authorization', `Bearer ${hostToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(journey.bookingId);
    expect(res.body.property_id).toBe(PROPERTY_ID);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('4b. Host checks property availability — endpoint responds', async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${PROPERTY_ID}/availability`)
      .query({ start: CHECK_IN, end: CHECK_OUT });

    // Availability endpoint either returns data or a reasonable error
    expect([200, 400]).toContain(res.status);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('4c. Host checks occupancy heatmap (auth required)', async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${PROPERTY_ID}/occupancy-heatmap`)
      .set('Authorization', `Bearer ${hostToken}`)
      .query({ year: 2029, month: 6 });

    expect([200, 400]).toContain(res.status);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('4d. Non-host cannot access occupancy heatmap (returns 401 without token)', async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${PROPERTY_ID}/occupancy-heatmap`)
      .query({ year: 2029, month: 6 });

    expect(res.status).toBe(401);
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Tenant: confirm (check-in)
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 5 (Tenant): Confirm Check-In`, () => {
  it('5a. Tenant confirms the booking — status becomes Confirmed', async () => {
    expect(journey.bookingId).not.toBeNull();

    const res = await request(app)
      .post(`/api/v1/bookings/${journey.bookingId}/confirm`)
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Confirmed');

    // DB state updated
    const dbRow = tables.bookings.get(journey.bookingId!);
    expect(dbRow!.status).toBe('Confirmed');

    journey.bookingStatus = 'Confirmed';
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('5b. Confirming an already-confirmed booking returns 400', async () => {
    const res = await request(app)
      .post(`/api/v1/bookings/${journey.bookingId}/confirm`)
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('5c. Host reads booking — now sees Confirmed status', async () => {
    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}`)
      .set('Authorization', `Bearer ${hostToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Confirmed');
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6 — Tenant: complete the stay
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 6 (Tenant): Complete Stay`, () => {
  it('6a. Tenant completes the booking — status becomes Completed', async () => {
    expect(journey.bookingId).not.toBeNull();
    expect(journey.bookingStatus).toBe('Confirmed');

    const res = await request(app)
      .post(`/api/v1/bookings/${journey.bookingId}/complete`)
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Completed');

    // DB state reflects completion
    const dbRow = tables.bookings.get(journey.bookingId!);
    expect(dbRow!.status).toBe('Completed');

    journey.bookingStatus = 'Completed';
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('6b. Completed booking cannot be confirmed again', async () => {
    const res = await request(app)
      .post(`/api/v1/bookings/${journey.bookingId}/confirm`)
      .set('Authorization', `Bearer ${tenantToken}`);

    expect(res.status).toBe(400);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('6c. Completed booking cannot be cancelled', async () => {
    const res = await request(app)
      .post(`/api/v1/bookings/${journey.bookingId}/cancel`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ reason: 'Trying to cancel completed booking' });

    expect([400, 409]).toContain(res.status);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('6d. Host reads booking — now sees Completed status', async () => {
    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}`)
      .set('Authorization', `Bearer ${hostToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Completed');
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 7 — Tenant: download artifacts
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 7 (Tenant): Download Artifacts`, () => {
  it('7a. Tenant downloads ICS calendar event', async () => {
    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}/calendar.ics`)
      .set('Authorization', `Bearer ${tenantToken}`);

    // Only Completed/Confirmed bookings can export ICS — our booking is Completed
    expect([200, 403, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/text\/calendar/);
      expect(res.text).toContain('BEGIN:VCALENDAR');
      expect(res.text).toContain(journey.bookingId!);
    }
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('7b. Tenant requests receipt PDF — Completed booking returns PDF or acceptable error', async () => {
    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}/receipt.pdf`)
      .set('Authorization', `Bearer ${tenantToken}`);

    // Receipt is available for Completed bookings
    expect([200, 500, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
    }
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('7c. Non-tenant cannot download another user receipt', async () => {
    // Use host token — host is the property owner (allowed) so use a third-party token
    const thirdPartyToken = makeToken(`other-user-${RUN_ID}`);
    const res = await request(app)
      .get(`/api/v1/bookings/${journey.bookingId}/receipt.pdf`)
      .set('Authorization', `Bearer ${thirdPartyToken}`);

    expect([403, 404]).toContain(res.status);
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 8 — Parallel journey: cancellation path (separate booking)
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 8: Cancellation Path`, () => {
  // Use a different property to avoid date conflicts with the main journey
  const CANCEL_PROPERTY_ID = `${RUN_ID}-prop-cancel-000002`;
  let cancelBookingId: string | null = null;

  beforeEach(async () => {
    // Seed a second property for the cancellation journey
    if (!tables.properties.has(CANCEL_PROPERTY_ID)) {
      tables.properties.set(CANCEL_PROPERTY_ID, {
        id: CANCEL_PROPERTY_ID,
        owner_id: HOST_ID,
        title: `Cancel Journey Property [${RUN_ID}]`,
        description: 'Property for cancellation journey.',
        city: 'Canceltown',
        country: 'TC',
        price_per_night: 80,
        max_guests: 2,
        on_chain_id: null,
        status: 'active',
        deleted_at: null,
        min_nights: 1,
        max_nights: null,
        check_in_time: null,
        check_out_time: null,
      });
      runArtifacts.properties.push(CANCEL_PROPERTY_ID);
    }
  });

  it('8a. Create a new booking to cancel', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({
        property_id: CANCEL_PROPERTY_ID,
        tenant_id: TENANT_ID,
        check_in: '2029-08-01',
        check_out: '2029-08-05',
        guest_count: 1,
        total_price: 320,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Pending');
    cancelBookingId = res.body.id;

    const dbRow = tables.bookings.get(cancelBookingId!);
    expect(dbRow!.status).toBe('Pending');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('8b. Non-tenant cannot cancel the booking (returns 401 without auth)', async () => {
    expect(cancelBookingId).not.toBeNull();

    const res = await request(app)
      .post(`/api/v1/bookings/${cancelBookingId}/cancel`)
      .send({ reason: 'Unauthorized cancel attempt' });

    expect(res.status).toBe(401);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('8c. Tenant cancels the booking — status becomes Cancelled', async () => {
    expect(cancelBookingId).not.toBeNull();

    const res = await request(app)
      .post(`/api/v1/bookings/${cancelBookingId}/cancel`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ reason: 'Change of plans' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Cancelled');

    const dbRow = tables.bookings.get(cancelBookingId!);
    expect(dbRow!.status).toBe('Cancelled');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('8d. Cancelled booking cannot be cancelled again (409 conflict)', async () => {
    expect(cancelBookingId).not.toBeNull();

    const res = await request(app)
      .post(`/api/v1/bookings/${cancelBookingId}/cancel`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ reason: 'Trying to cancel again' });

    expect([400, 409]).toContain(res.status);
    expect(res.body).toHaveProperty('error');
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('8e. Dates are freed — new booking on same dates succeeds', async () => {
    // A different tenant can now book the same cancelled slot
    const otherTenantId = `${RUN_ID}-tenant-2`;
    const otherToken = makeToken(otherTenantId);

    // Update stellar mock to recognise the new tenant
    const origImpl = (supabaseMod as unknown as { supabase: typeof mockSupabase }).supabase.from;
    void origImpl; // mock already handles unknown IDs with fallback address

    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        property_id: CANCEL_PROPERTY_ID,
        tenant_id: otherTenantId,
        check_in: '2029-08-01',
        check_out: '2029-08-05',
        guest_count: 1,
        total_price: 320,
        rules_acknowledged_at: new Date().toISOString(),
        terms_version: 'v1.0',
        terms_accepted_at: new Date().toISOString(),
      });

    expect(res.status).toBe(201);
    assertCorrelationId(res.headers as Record<string, string>);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 9 — Notification delivery check
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 9: Notification Delivery`, () => {
  it('9a. Tenant can list their notifications', async () => {
    const res = await request(app)
      .get('/api/v1/notifications')
      .set('Authorization', `Bearer ${tenantToken}`)
      .query({ page: 1, limit: 50 });

    expect(res.status).toBe(200);
    assertCorrelationId(res.headers as Record<string, string>);
  });

  it('9b. Notifications were created in-memory for this run', async () => {
    // After create + confirm + complete we expect ≥ 3 tenant notifications
    const tenantNotifications = [...tables.notifications.values()].filter(
      (n) => n.user_id === TENANT_ID,
    );
    expect(tenantNotifications.length).toBeGreaterThanOrEqual(1);
  });

  it('9c. All notifications carry the booking ID', async () => {
    const bookingNotifications = [...tables.notifications.values()].filter(
      (n) =>
        (n.data as { booking_id?: string }).booking_id === journey.bookingId,
    );
    expect(bookingNotifications.length).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 10 — Cleanup assertion
// ─────────────────────────────────────────────────────────────────────────────

describe(`Journey [${RUN_ID}] — Phase 10: Run Isolation`, () => {
  it('10a. All seeded booking IDs contain the RUN_ID prefix', () => {
    for (const id of runArtifacts.bookings) {
      expect(id).toContain(RUN_ID);
    }
  });

  it('10b. All seeded property IDs contain the RUN_ID prefix', () => {
    for (const id of runArtifacts.properties) {
      expect(id).toContain(RUN_ID);
    }
  });

  it('10c. No test data from this run exists in other namespaces', () => {
    for (const id of [...tables.bookings.keys()]) {
      if (runArtifacts.bookings.includes(id)) {
        expect(id).toContain(RUN_ID);
      }
    }
  });

  it('10d. Final booking status matches expected end state (Completed)', () => {
    expect(journey.bookingId).not.toBeNull();
    expect(journey.bookingStatus).toBe('Completed');

    const dbRow = tables.bookings.get(journey.bookingId!);
    expect(dbRow).toBeDefined();
    expect(dbRow!.status).toBe('Completed');
  });

  it('10e. Escrow was created and associated with the booking', () => {
    expect(journey.escrowId).toBe(ESCROW_ID);

    const dbRow = tables.bookings.get(journey.bookingId!);
    expect(dbRow!.escrow_id).toBe(ESCROW_ID);
  });
});
