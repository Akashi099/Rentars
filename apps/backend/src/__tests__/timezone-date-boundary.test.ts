/**
 * Timezone and date-boundary test suite — Issue #605
 *
 * Covers:
 *  1. calcNights() — UTC-safe calendar arithmetic across DST, leap days,
 *     year/month boundaries, and same-day edge cases
 *  2. createBookingSchema — date validation rules (past dates, ordering,
 *     same-day rejection, ISO format)
 *  3. isInQuietHours() — timezone-aware quiet-window evaluation including
 *     wrap-midnight windows, multiple IANA zones, invalid-timezone fallback
 *  4. Adjacent-booking date semantics — checkout of one booking equals
 *     check-in of the next (exclusive-end convention)
 */

import { describe, it, expect } from 'vitest';
import { calcNights } from '../services/receipt.service.js';
import { createBookingSchema } from '../validators/booking.validator.js';
import { isInQuietHours } from '../services/reminder.service.js';
import type { NotificationPreferences } from '../services/notification.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal NotificationPreferences object with quiet-hour fields. */
function makePrefs(
  start: string | null,
  end: string | null,
  tz: string | null = 'UTC',
): NotificationPreferences {
  return {
    user_id:              'user-1',
    email_notifications:  true,
    push_notifications:   true,
    notification_types:   {},
    quiet_hours_start:    start,
    quiet_hours_end:      end,
    quiet_hours_timezone: tz,
  };
}

/** Return a Date fixed at a specific UTC clock time on an arbitrary day. */
function utcAt(hour: number, minute = 0): Date {
  const d = new Date('2027-01-15T00:00:00Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ─── calcNights — calendar-day arithmetic ─────────────────────────────────────

describe('calcNights() — UTC calendar-day arithmetic', () => {

  // ── Ordinary cases ─────────────────────────────────────────────────────────

  it('counts a 4-night stay correctly', () => {
    expect(calcNights('2027-08-01', '2027-08-05')).toBe(4);
  });

  it('counts a single-night stay as 1', () => {
    expect(calcNights('2027-08-01', '2027-08-02')).toBe(1);
  });

  it('floors same-day check-in/out to 1 (minimum)', () => {
    expect(calcNights('2027-08-01', '2027-08-01')).toBe(1);
  });

  it('counts a long stay (30 nights) correctly', () => {
    expect(calcNights('2027-06-01', '2027-07-01')).toBe(30);
  });

  // ── Boundary crossings ─────────────────────────────────────────────────────

  it('counts correctly across a month boundary (Jan→Feb)', () => {
    expect(calcNights('2027-01-30', '2027-02-02')).toBe(3);
  });

  it('counts correctly across a year boundary (Dec→Jan)', () => {
    expect(calcNights('2026-12-29', '2027-01-02')).toBe(4);
  });

  // ── Leap year — 2028 is a leap year ────────────────────────────────────────

  it('counts a stay that spans Feb 29 on a leap year (2 nights)', () => {
    // 2028-02-28 → 2028-03-01 crosses the leap day
    expect(calcNights('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('counts a stay starting on leap day correctly', () => {
    expect(calcNights('2028-02-29', '2028-03-02')).toBe(2);
  });

  it('counts a single night ending on leap day', () => {
    expect(calcNights('2028-02-28', '2028-02-29')).toBe(1);
  });

  it('counts a single night starting on leap day', () => {
    expect(calcNights('2028-02-29', '2028-03-01')).toBe(1);
  });

  it('counts a stay entirely within a Feb on a non-leap year', () => {
    // 2027 is not a leap year — Feb has 28 days
    expect(calcNights('2027-02-25', '2027-03-01')).toBe(4);
  });

  // ── DST spring-forward: 2027-03-28 (CET→CEST, Europe) ─────────────────────

  it('gives 2 for a 2-night stay spanning the spring-forward boundary', () => {
    // A naïve wall-clock diff would yield 23 h ≈ 0.958 days — wrong
    expect(calcNights('2027-03-27', '2027-03-29')).toBe(2);
  });

  it('gives 1 for a single night spanning the spring-forward boundary', () => {
    expect(calcNights('2027-03-28', '2027-03-29')).toBe(1);
  });

  // ── DST fall-back: 2027-10-31 (CEST→CET, Europe) ──────────────────────────

  it('gives 2 for a 2-night stay spanning the fall-back boundary', () => {
    // A naïve wall-clock diff would yield 25 h ≈ 1.041 days — wrong
    expect(calcNights('2027-10-30', '2027-11-01')).toBe(2);
  });

  it('gives 1 for a single night spanning the fall-back boundary', () => {
    expect(calcNights('2027-10-31', '2027-11-01')).toBe(1);
  });
});

// ─── createBookingSchema — date validation rules ──────────────────────────────

describe('createBookingSchema — date boundary validation', () => {

  // Far-future dates: safe against any "must not be in the past" check.
  const FUTURE_IN     = '2029-06-10';
  const FUTURE_OUT    = '2029-06-14';
  const TODAY         = new Date().toISOString().slice(0, 10);
  const YESTERDAY     = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // RFC 4122-compliant UUID required by Zod v4
  const PROP_UUID     = '3d9e8f0a-1b2c-4d5e-a6f7-8b9c0d1e2f3a';

  const BASE = {
    property_id:           PROP_UUID,
    check_in:              FUTURE_IN,
    check_out:             FUTURE_OUT,
    guest_count:           2,
    rules_acknowledged_at: '2029-01-01T10:00:00.000Z',
    terms_version:         'v1',
    terms_accepted_at:     '2029-01-01T10:00:00.000Z',
  };

  it('accepts a valid booking', () => {
    expect(createBookingSchema.safeParse(BASE).success).toBe(true);
  });

  it('rejects check_in in the past', () => {
    const result = createBookingSchema.safeParse({ ...BASE, check_in: YESTERDAY });
    expect(result.success).toBe(false);
    const msgs = result.success ? [] : result.error.issues.map(i => i.message);
    expect(msgs.some(m => /past/i.test(m))).toBe(true);
  });

  it('accepts check_in one day in the future (date ordering boundary)', () => {
    // check_in tomorrow, check_out 3 days later — must not trigger past-date rejection
    const tomorrow  = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const checkOut  = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
    const result    = createBookingSchema.safeParse({ ...BASE, check_in: tomorrow, check_out: checkOut });
    const msgs      = result.success ? [] : result.error.issues.map(i => i.message);
    expect(msgs.some(m => /past/i.test(m))).toBe(false);
  });

  it('rejects check_out <= check_in (same day)', () => {
    const result = createBookingSchema.safeParse({ ...BASE, check_out: FUTURE_IN });
    expect(result.success).toBe(false);
    const msgs = result.success ? [] : result.error.issues.map(i => i.message);
    expect(msgs.some(m => /after/i.test(m))).toBe(true);
  });

  it('rejects check_out before check_in', () => {
    const result = createBookingSchema.safeParse({ ...BASE, check_out: FUTURE_IN, check_in: FUTURE_OUT });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid date string for check_in', () => {
    const result = createBookingSchema.safeParse({ ...BASE, check_in: '2027-13-01' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO date string for check_out', () => {
    const result = createBookingSchema.safeParse({ ...BASE, check_out: '01/08/2027' });
    expect(result.success).toBe(false);
  });

  it('rejects guest_count of 0', () => {
    const result = createBookingSchema.safeParse({ ...BASE, guest_count: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects fractional guest_count', () => {
    const result = createBookingSchema.safeParse({ ...BASE, guest_count: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects negative guest_count', () => {
    const result = createBookingSchema.safeParse({ ...BASE, guest_count: -1 });
    expect(result.success).toBe(false);
  });
});

// ─── Adjacent-booking date semantics ─────────────────────────────────────────

describe('Adjacent-booking date semantics (exclusive check-out convention)', () => {
  /**
   * The platform treats check-out as exclusive: a booking from Aug 1–5 ends
   * on the morning of Aug 5 and a new booking may start on Aug 5.
   *
   * calcNights() correctly reflects this: it counts calendar days from
   * check-in (inclusive) to check-out (exclusive).
   */

  it('two adjacent bookings have no nights overlap', () => {
    const firstCheckOut  = '2027-08-05';
    const secondCheckIn  = '2027-08-05'; // same day — valid turnover
    const secondCheckOut = '2027-08-10';

    const firstNights  = calcNights('2027-08-01', firstCheckOut);
    const secondNights = calcNights(secondCheckIn, secondCheckOut);

    expect(firstNights).toBe(4);
    expect(secondNights).toBe(5);
    // Total = 9 nights; no overlap between the two stays
    expect(firstNights + secondNights).toBe(9);
  });

  it('a 1-night stay followed immediately by another 1-night stay', () => {
    expect(calcNights('2027-08-01', '2027-08-02')).toBe(1);
    expect(calcNights('2027-08-02', '2027-08-03')).toBe(1);
  });

  it('nights count for consecutive week stays totals 7', () => {
    // Mon–Wed (2) + Wed–Sun (4) + Sun–Mon (1) = 7
    expect(calcNights('2027-08-02', '2027-08-04') +
           calcNights('2027-08-04', '2027-08-08') +
           calcNights('2027-08-08', '2027-08-09')).toBe(7);
  });
});

// ─── isInQuietHours — timezone-aware window evaluation ────────────────────────

describe('isInQuietHours() — quiet-window evaluation', () => {

  // ── No quiet window ────────────────────────────────────────────────────────

  it('returns false when quiet_hours_start is null', () => {
    expect(isInQuietHours(makePrefs(null, '08:00'))).toBe(false);
  });

  it('returns false when quiet_hours_end is null', () => {
    expect(isInQuietHours(makePrefs('22:00', null))).toBe(false);
  });

  it('returns false when both are null', () => {
    expect(isInQuietHours(makePrefs(null, null))).toBe(false);
  });

  // ── Wrapping window (22:00–08:00) in UTC ───────────────────────────────────

  it('returns true at 23:00 UTC inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(23))).toBe(true);
  });

  it('returns true at 00:00 UTC inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(0))).toBe(true);
  });

  it('returns true at 07:59 UTC inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(7, 59))).toBe(true);
  });

  it('returns true exactly at the start boundary (22:00)', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(22, 0))).toBe(true);
  });

  it('returns false at 14:00 UTC outside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(14))).toBe(false);
  });

  it('returns false exactly at the end boundary (08:00) — window is half-open [start, end)', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(8, 0))).toBe(false);
  });

  // ── Non-wrapping window (08:00–20:00) in UTC ──────────────────────────────

  it('returns true at 12:00 UTC inside a 08:00–20:00 window', () => {
    expect(isInQuietHours(makePrefs('08:00', '20:00'), utcAt(12))).toBe(true);
  });

  it('returns false at 21:00 UTC outside a 08:00–20:00 window', () => {
    expect(isInQuietHours(makePrefs('08:00', '20:00'), utcAt(21))).toBe(false);
  });

  it('returns false at 07:59 UTC before a 08:00–20:00 window', () => {
    expect(isInQuietHours(makePrefs('08:00', '20:00'), utcAt(7, 59))).toBe(false);
  });

  // ── Non-UTC timezone: America/New_York (UTC-5 in winter) ──────────────────

  it('returns true when UTC-5 clock is 23:00 inside a 22:00–08:00 NY window', () => {
    // 23:00 NY = 04:00 UTC next day (winter, UTC-5)
    const utc04 = new Date('2027-01-15T04:00:00Z');
    expect(isInQuietHours(makePrefs('22:00', '08:00', 'America/New_York'), utc04)).toBe(true);
  });

  it('returns false when UTC-5 clock is 10:00 outside a 22:00–08:00 NY window', () => {
    // 10:00 NY = 15:00 UTC (winter, UTC-5)
    const utc15 = new Date('2027-01-15T15:00:00Z');
    expect(isInQuietHours(makePrefs('22:00', '08:00', 'America/New_York'), utc15)).toBe(false);
  });

  // ── Asia/Tokyo (UTC+9) ─────────────────────────────────────────────────────

  it('returns true when Tokyo clock is 23:30 inside a 22:00–07:00 Tokyo window', () => {
    // 23:30 JST = 14:30 UTC
    const utc1430 = new Date('2027-01-15T14:30:00Z');
    expect(isInQuietHours(makePrefs('22:00', '07:00', 'Asia/Tokyo'), utc1430)).toBe(true);
  });

  it('returns false when Tokyo clock is 12:00 outside a 22:00–07:00 Tokyo window', () => {
    // 12:00 JST = 03:00 UTC
    const utc03 = new Date('2027-01-15T03:00:00Z');
    expect(isInQuietHours(makePrefs('22:00', '07:00', 'Asia/Tokyo'), utc03)).toBe(false);
  });

  // ── Invalid timezone — fail-open (do not suppress delivery) ───────────────

  it('returns false for an invalid timezone string', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00', 'Not/ATimezone'))).toBe(false);
  });

  it('returns false for an empty timezone string', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00', ''))).toBe(false);
  });
});

// ─── UTC-midnight invariant ───────────────────────────────────────────────────

describe('UTC-midnight invariant — dates are calendar-day concepts', () => {
  /**
   * Booking dates are YYYY-MM-DD strings that represent calendar days, not
   * instants. calcNights() must produce the same result regardless of the
   * timezone or time of day the server runs in.
   */

  it('produces the same night count regardless of sub-day input variation', () => {
    // All represent the same calendar days — result must be 4
    expect(calcNights('2027-08-01T00:00:00Z', '2027-08-05T00:00:00Z')).toBe(4);
    expect(calcNights('2027-08-01T12:00:00Z', '2027-08-05T23:59:59Z')).toBe(4);
  });

  it('truncates time components when they are present in the input', () => {
    // Times after midnight on the same day must not shift the date
    expect(calcNights('2027-08-01T23:59:59+05:30', '2027-08-05T00:00:01-08:00')).toBe(4);
  });
});
