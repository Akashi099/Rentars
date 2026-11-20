/**
 * #925: one availability model across the calendar, search, quotes and booking.
 *
 * Covers the reserving-status matrix, half-open date boundaries (adjacent stays),
 * UTC day handling for timestamps with offsets, expired and cancelled holds, and
 * that quotes derive their availability from the same per-night rules.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  enumerateNights,
  nightInRange,
  rangesOverlap,
  toDay,
} from '../../src/utils/availabilityRange.js';
import { RESERVING_BOOKING_STATUSES, reservesDates } from '../../src/utils/bookingStatus.js';
import {
  type FakeSupabase,
  createFakeSupabase,
  currentFakeSupabase,
  useFakeSupabase,
} from './helpers/fakeSupabase';

mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (table: string) => currentFakeSupabase().from(table),
  },
}));

// Other test files mock these services process-wide (bun's mock registry is shared).
// Importing with a unique query string gives this file its own copy of the real
// module, so it is not affected by those mocks or by their load order.
const fresh = (path: string) => import(`${path}?availability-spec`);
const availability = await fresh('../../src/services/availability.service.ts');
const calendar = await fresh('../../src/services/calendar.service.ts');
const pricing = await fresh('../../src/services/pricing.service.ts');

const PROP = 'prop-1';

function install(f: FakeSupabase): FakeSupabase {
  useFakeSupabase(f);
  return f;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('reserving statuses', () => {
  it.each([
    ['Pending', true],
    ['Confirmed', true],
    ['Completed', true],
    ['Disputed', true],
    ['Cancelled', false],
    ['Expired', false],
  ])('%s reserves dates: %p', (status, expected) => {
    expect(reservesDates(status)).toBe(expected);
  });

  it('is the set the booking RPC and the exclusion constraint both use', () => {
    expect([...RESERVING_BOOKING_STATUSES].sort()).toEqual([
      'Completed',
      'Confirmed',
      'Disputed',
      'Pending',
    ]);
  });
});

describe('half-open date ranges', () => {
  it('treats back-to-back stays as non-overlapping', () => {
    // 1–5 May, then 5–8 May: the checkout day is free for the next check-in.
    expect(rangesOverlap('2026-05-01', '2026-05-05', '2026-05-05', '2026-05-08')).toBe(false);
  });

  it('detects any shared night', () => {
    expect(rangesOverlap('2026-05-01', '2026-05-05', '2026-05-04', '2026-05-08')).toBe(true);
    expect(rangesOverlap('2026-05-01', '2026-05-10', '2026-05-03', '2026-05-04')).toBe(true);
  });

  it('counts a night as blocked only inside [start, end)', () => {
    expect(nightInRange('2026-05-04', '2026-05-01', '2026-05-05')).toBe(true);
    expect(nightInRange('2026-05-05', '2026-05-01', '2026-05-05')).toBe(false);
  });

  it('enumerates the nights of a stay and excludes check-out', () => {
    expect(enumerateNights('2026-05-01', '2026-05-04')).toEqual([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
    ]);
    expect(enumerateNights('2026-05-04', '2026-05-04')).toEqual([]);
  });
});

describe('UTC day normalisation', () => {
  it('reduces a timestamp with an offset to its UTC calendar day', () => {
    // 23:30 on 1 March at UTC-5 is 04:30 on 2 March in UTC.
    expect(toDay('2026-03-01T23:30:00-05:00')).toBe('2026-03-02');
  });

  it('keeps a plain date unchanged', () => {
    expect(toDay('2026-03-01')).toBe('2026-03-01');
  });

  it('does not shift a stay when check-in is given with an offset', () => {
    expect(enumerateNights('2026-03-01T00:30:00+02:00', '2026-03-04')).toEqual([
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
    ]);
  });
});

// ─── checkDateRangeAvailability ───────────────────────────────────────────────

describe('checkDateRangeAvailability — reserving bookings and holds', () => {
  const booking = (status: string, check_in: string, check_out: string) => ({
    id: `b-${status}-${check_in}`,
    property_id: PROP,
    status,
    check_in,
    check_out,
  });

  it.each(['Pending', 'Confirmed', 'Completed', 'Disputed'])(
    'a %s booking makes overlapping dates unavailable',
    async (status) => {
      install(createFakeSupabase({ bookings: [booking(status, '2026-05-01', '2026-05-05')] }));
      const r = await availability.checkDateRangeAvailability(PROP, '2026-05-03', '2026-05-06');
      expect(r.data?.is_available).toBe(false);
      expect(r.data?.unavailable_reason).toMatch(/already booked/i);
    }
  );

  it.each(['Expired', 'Cancelled'])('a %s booking does not block the dates', async (status) => {
    install(createFakeSupabase({ bookings: [booking(status, '2026-05-01', '2026-05-05')] }));
    const r = await availability.checkDateRangeAvailability(PROP, '2026-05-01', '2026-05-05');
    expect(r.data?.is_available).toBe(true);
  });

  it('allows an adjacent stay that starts on the previous stay’s check-out day', async () => {
    install(createFakeSupabase({ bookings: [booking('Confirmed', '2026-05-01', '2026-05-05')] }));
    const r = await availability.checkDateRangeAvailability(PROP, '2026-05-05', '2026-05-08');
    expect(r.data?.is_available).toBe(true);
  });

  it('allows an adjacent stay that ends on the next booking’s check-in day', async () => {
    install(createFakeSupabase({ bookings: [booking('Confirmed', '2026-05-05', '2026-05-08')] }));
    const r = await availability.checkDateRangeAvailability(PROP, '2026-05-01', '2026-05-05');
    expect(r.data?.is_available).toBe(true);
  });

  it('treats a host block as unavailable, but not on its checkout boundary', async () => {
    install(
      createFakeSupabase({
        availability_ranges: [
          {
            property_id: PROP,
            is_available: false,
            start_date: '2026-05-10',
            end_date: '2026-05-15',
          },
        ],
      })
    );
    const onBlock = await availability.checkDateRangeAvailability(PROP, '2026-05-12', '2026-05-13');
    expect(onBlock.data?.is_available).toBe(false);
    const ends = await availability.checkDateRangeAvailability(PROP, '2026-05-15', '2026-05-17');
    expect(ends.data?.is_available).toBe(true);
  });
});

// ─── blockAvailabilityRange ───────────────────────────────────────────────────

describe('blockAvailabilityRange — cannot block over a reserving booking', () => {
  const owned = (extra: Record<string, unknown[]> = {}) =>
    createFakeSupabase({
      properties: [{ id: PROP, owner_id: 'owner-1' }],
      availability_ranges: [],
      ...extra,
    });

  it.each(['Pending', 'Confirmed', 'Disputed', 'Completed'])(
    'refuses a block that overlaps a %s booking',
    async (status) => {
      install(
        owned({
          bookings: [
            {
              id: 'b1',
              property_id: PROP,
              status,
              check_in: '2026-06-01',
              check_out: '2026-06-05',
            },
          ],
        })
      );
      const r = await availability.blockAvailabilityRange(PROP, 'owner-1', {
        start_date: '2026-06-03',
        end_date: '2026-06-07',
      });
      expect(r.success).toBe(false);
    }
  );

  it('allows a block over an Expired hold', async () => {
    install(
      owned({
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Expired',
            check_in: '2026-06-01',
            check_out: '2026-06-05',
          },
        ],
      })
    );
    const r = await availability.blockAvailabilityRange(PROP, 'owner-1', {
      start_date: '2026-06-03',
      end_date: '2026-06-07',
    });
    expect(r.success).toBe(true);
  });

  it('allows a block that starts on the booking’s checkout day', async () => {
    install(
      owned({
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Confirmed',
            check_in: '2026-06-01',
            check_out: '2026-06-05',
          },
        ],
      })
    );
    const r = await availability.blockAvailabilityRange(PROP, 'owner-1', {
      start_date: '2026-06-05',
      end_date: '2026-06-07',
    });
    expect(r.success).toBe(true);
  });
});

// ─── Calendar ─────────────────────────────────────────────────────────────────

describe('checkAvailabilityAtomic — same rule as the RPC', () => {
  it('accepts an adjacent stay', async () => {
    install(
      createFakeSupabase({
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Confirmed',
            check_in: '2026-07-01',
            check_out: '2026-07-04',
          },
        ],
        availability_ranges: [],
      })
    );
    const r = await calendar.checkAvailabilityAtomic(PROP, '2026-07-04', '2026-07-06');
    expect(r.data?.available).toBe(true);
  });

  it('rejects an overlapping stay', async () => {
    install(
      createFakeSupabase({
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Pending',
            check_in: '2026-07-01',
            check_out: '2026-07-04',
          },
        ],
        availability_ranges: [],
      })
    );
    const r = await calendar.checkAvailabilityAtomic(PROP, '2026-07-03', '2026-07-06');
    expect(r.data?.available).toBe(false);
  });

  it('ignores an Expired hold', async () => {
    install(
      createFakeSupabase({
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Expired',
            check_in: '2026-07-01',
            check_out: '2026-07-04',
          },
        ],
        availability_ranges: [],
      })
    );
    const r = await calendar.checkAvailabilityAtomic(PROP, '2026-07-02', '2026-07-03');
    expect(r.data?.available).toBe(true);
  });

  it('counts nights on UTC days, not by elapsed hours', async () => {
    install(createFakeSupabase({ bookings: [], availability_ranges: [] }));
    // Two nights, with check-in given as a timestamp with an offset.
    const r = await calendar.checkAvailabilityAtomic(
      PROP,
      '2026-07-01T00:00:00Z',
      '2026-07-03T00:00:00Z',
      2
    );
    expect(r.data?.available).toBe(true);
    const short = await calendar.checkAvailabilityAtomic(
      PROP,
      '2026-07-01T00:00:00Z',
      '2026-07-02T00:00:00Z',
      2
    );
    expect(short.data?.available).toBe(false);
  });
});

// ─── Quotes agree with the nightly breakdown ──────────────────────────────────

describe('quote availability is derived from the nightly breakdown', () => {
  const property = {
    id: PROP,
    base_price_per_night: 100,
    updated_at: '2026-01-01T00:00:00Z',
    status: 'available',
    draft_status: null,
    deleted_at: null,
    moderation_state: 'visible',
    max_guests: 4,
  };

  it('marks a night unavailable when a blocked special event covers it', async () => {
    install(
      createFakeSupabase({
        properties: [property],
        bookings: [],
        availability_ranges: [],
        seasonal_pricing: [],
        special_events: [
          {
            property_id: PROP,
            name: 'Maintenance',
            start_date: '2026-08-02',
            end_date: '2026-08-03',
            is_blocked: true,
          },
        ],
      })
    );
    const r = await pricing.getPropertyQuote(PROP, '2026-08-01', '2026-08-04');
    expect(r.success).toBe(true);
    expect(r.data?.available).toBe(false);
    expect(r.data?.unavailable_intervals).toEqual([
      { start: '2026-08-02', end: '2026-08-03', reason: 'Blocked: Maintenance' },
    ]);
  });

  it('groups consecutive unavailable nights into one interval', () => {
    const runs = pricing.unavailableRuns([
      { date: '2026-09-01', price: 0, is_available: false, reason: 'Already booked' },
      { date: '2026-09-02', price: 0, is_available: false, reason: 'Already booked' },
      { date: '2026-09-03', price: 100, is_available: true },
      { date: '2026-09-04', price: 0, is_available: false, reason: 'Host blocked' },
    ]);
    expect(runs).toEqual([
      { start: '2026-09-01', end: '2026-09-03', reason: 'Booking conflict' },
      { start: '2026-09-04', end: '2026-09-05', reason: 'Host blocked' },
    ]);
  });

  it('is available for an adjacent stay after a Confirmed booking', async () => {
    install(
      createFakeSupabase({
        properties: [property],
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Confirmed',
            check_in: '2026-08-01',
            check_out: '2026-08-04',
          },
        ],
        availability_ranges: [],
        seasonal_pricing: [],
        special_events: [],
      })
    );
    const r = await pricing.getPropertyQuote(PROP, '2026-08-04', '2026-08-06');
    expect(r.data?.available).toBe(true);
    expect(r.data?.nights).toBe(2);
  });

  it('prices an expired hold as free', async () => {
    install(
      createFakeSupabase({
        properties: [property],
        bookings: [
          {
            id: 'b1',
            property_id: PROP,
            status: 'Expired',
            check_in: '2026-08-01',
            check_out: '2026-08-04',
          },
        ],
        availability_ranges: [],
        seasonal_pricing: [],
        special_events: [],
      })
    );
    const r = await pricing.getPropertyQuote(PROP, '2026-08-01', '2026-08-03');
    expect(r.data?.available).toBe(true);
  });
});
