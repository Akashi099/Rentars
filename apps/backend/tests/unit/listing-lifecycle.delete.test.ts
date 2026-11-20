/**
 * #923: listing soft-delete. Covers authorisation, the active-reservation
 * refusal (including the post-write re-check and rollback), idempotency and
 * cache invalidation of featured variants.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  type FakeSupabase,
  createFakeSupabase,
  currentFakeSupabase,
  useFakeSupabase,
} from './helpers/fakeSupabase';

const cacheDeleted: string[] = [];
mock.module('../../src/services/cache.service.js', () => ({
  get: async () => null,
  set: async () => undefined,
  del: async (key: string) => {
    cacheDeleted.push(key);
  },
  invalidatePattern: async () => undefined,
}));

let fake: FakeSupabase;
// bun snapshots module exports, so export a stable object that delegates to the
// fake installed for the current test (see helpers/fakeSupabase.ts).
mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (table: string) => currentFakeSupabase().from(table),
  },
}));

// Isolated instance: see listing-availability.test.ts for why.
const { deleteProperty } = await import('../../src/services/property.service.ts?lifecycle-spec');

const OWNER = 'owner-1';
const OTHER = 'someone-else';
const FUTURE = '2999-01-10';
const PAST = '2000-01-10';

/** Make `f` the fake the module mock delegates to, and return it. */
function install(f: FakeSupabase): FakeSupabase {
  useFakeSupabase(f);
  return f;
}

function seed(bookings: Array<Record<string, unknown>> = []): FakeSupabase {
  return install(
    createFakeSupabase({
      properties: [{ id: 'prop-1', owner_id: OWNER, deleted_at: null }],
      bookings: bookings.map((b, i) => ({ id: `bk-${i}`, property_id: 'prop-1', ...b })),
    })
  );
}

describe('deleteProperty — authorisation', () => {
  beforeEach(() => {
    cacheDeleted.length = 0;
  });

  it('lets the owner delete their listing', async () => {
    fake = seed();
    const result = await deleteProperty('prop-1', { id: OWNER, role: 'user' });
    expect(result.success).toBe(true);
    expect(fake.tables.properties[0].deleted_at).toEqual(expect.any(String));
  });

  it('refuses a signed-in user who does not own the listing and leaves it untouched', async () => {
    fake = seed();
    const result = await deleteProperty('prop-1', { id: OTHER, role: 'user' });
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(fake.tables.properties[0].deleted_at).toBeNull();
  });

  it('lets an administrator delete any listing', async () => {
    fake = seed();
    const result = await deleteProperty('prop-1', { id: OTHER, role: 'admin' });
    expect(result.success).toBe(true);
  });

  it('returns 404 for an unknown listing', async () => {
    fake = seed();
    const result = await deleteProperty('missing', { id: OWNER });
    expect(result.statusCode).toBe(404);
  });

  it('is idempotent for an already-deleted listing', async () => {
    fake = install(
      createFakeSupabase({
        properties: [{ id: 'prop-1', owner_id: OWNER, deleted_at: PAST }],
        bookings: [],
      })
    );
    const result = await deleteProperty('prop-1', { id: OWNER });
    expect(result.success).toBe(true);
    expect(fake.tables.properties[0].deleted_at).toBe(PAST);
  });
});

describe('deleteProperty — active reservations', () => {
  beforeEach(() => {
    cacheDeleted.length = 0;
  });

  it.each(['Pending', 'Confirmed', 'Disputed'])(
    'refuses deletion while a %s booking has not yet checked out',
    async (status) => {
      fake = seed([{ status, check_in: '2998-01-01', check_out: FUTURE }]);
      const result = await deleteProperty('prop-1', { id: OWNER });
      expect(result.success).toBe(false);
      expect(result.code).toBe('PROPERTY_HAS_ACTIVE_BOOKINGS');
      expect(result.statusCode).toBe(409);
      expect(fake.tables.properties[0].deleted_at).toBeNull();
    }
  );

  it.each([
    ['Completed', FUTURE],
    ['Cancelled', FUTURE],
    ['Expired', FUTURE],
    ['Confirmed', PAST],
  ])('allows deletion when the only booking is %s (check-out %s)', async (status, checkOut) => {
    fake = seed([{ status, check_in: '1999-12-01', check_out: checkOut }]);
    const result = await deleteProperty('prop-1', { id: OWNER });
    expect(result.success).toBe(true);
  });

  it('rolls the tombstone back when a booking appears after the first check', async () => {
    fake = seed();
    // Simulate a booking written in the gap between the pre-check and the re-check
    // by injecting it on the tombstone write.
    const originalFrom = fake.from;
    let injected = false;
    fake.from = ((table: string) => {
      const builder = originalFrom(table) as Record<string, unknown>;
      if (table !== 'properties') return builder;
      const originalUpdate = builder.update as (v: Record<string, unknown>) => unknown;
      builder.update = (values: Record<string, unknown>) => {
        if (!injected && values.deleted_at) {
          injected = true;
          fake.tables.bookings.push({
            id: 'racing',
            property_id: 'prop-1',
            status: 'Pending',
            check_in: FUTURE,
            check_out: '2999-02-01',
          });
        }
        return originalUpdate(values);
      };
      return builder;
    }) as FakeSupabase['from'];

    const result = await deleteProperty('prop-1', { id: OWNER });
    expect(result.success).toBe(false);
    expect(result.code).toBe('PROPERTY_HAS_ACTIVE_BOOKINGS');
    expect(fake.tables.properties[0].deleted_at).toBeNull();
  });
});

describe('deleteProperty — cache invalidation', () => {
  it('clears the per-cap featured cache keys, not only the bare featured key', async () => {
    cacheDeleted.length = 0;
    fake = seed();
    await deleteProperty('prop-1', { id: OWNER });
    expect(cacheDeleted).toContain('property:prop-1');
    expect(cacheDeleted).toContain('properties:all');
    expect(cacheDeleted).toContain('properties:featured:1');
    expect(cacheDeleted).toContain('properties:featured:6');
  });
});
