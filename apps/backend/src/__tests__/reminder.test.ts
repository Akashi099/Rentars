/**
 * Tests for Feature C — Booking Reminder Scheduler
 *
 * Covers:
 *  1. markReminderSent — inserts a row; treats unique violation as already-sent
 *  2. isReminderSent — checks existence without inserting
 *  3. runReminderScheduler — sends reminders once, skips on re-run (dedup),
 *     respects notification preferences
 *  4. isInQuietHours — quiet-window evaluation (wrap-midnight, same-day,
 *     timezone handling, invalid timezone fallback)
 *  5. Scheduler quiet-hours integration — defers without consuming idempotency slot
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  markReminderSent,
  isReminderSent,
  runReminderScheduler,
  getLeadTimeHours,
  isInQuietHours,
} from '../services/reminder.service.js';
import type { NotificationPreferences } from '../services/notification.service.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockInsert      = vi.fn();
const mockMaybeSingle = vi.fn();
const mockSingle      = vi.fn();
const mockSelectEqEq  = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockSelectEq    = vi.fn(() => ({
  maybeSingle: mockMaybeSingle,
  eq: mockSelectEqEq,
}));

// Terminal resolved value for any booking query that doesn't have an explicit
// mockResolvedValueOnce set (e.g. payment-deadline / dispute queries in tests
// that only care about check-in/check-out behaviour).
const EMPTY_BOOKINGS = Promise.resolve({ data: [], error: null });

const mockNot = vi.fn();

// mockLte is both chainable (returns { not: mockNot }) AND directly awaitable
// (falls back to an empty result).  Object.assign attaches .not onto a Promise
// so `await chain.lte(...)` resolves to EMPTY_BOOKINGS while
// `chain.lte(...).not(...)` still works via the mocked mockNot.
const makeLteResult = () =>
  Object.assign(Promise.resolve({ data: [], error: null }), { not: mockNot });
const mockLte   = vi.fn(makeLteResult);
const mockGte   = vi.fn(() => ({ lte: mockLte }));

// eq() used by processPaymentDeadlineReminders / processDisputeReminders
const mockBookingEq = vi.fn(() => ({ gte: mockGte, lte: mockLte }));
const mockBookingSelect = vi.fn(() => ({ gte: mockGte, eq: mockBookingEq }));

const mockFrom = vi.fn((table: string) => {
  if (table === 'booking_reminders') {
    return {
      insert: mockInsert,
      select: vi.fn(() => ({ eq: mockSelectEq })),
    };
  }
  if (table === 'bookings') {
    return { select: mockBookingSelect };
  }
  if (table === 'users') {
    return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })) };
  }
  return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: mockSingle })) })) };
});

vi.mock('../config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

// ─── Notification service mock ────────────────────────────────────────────────

const mockCreateNotificationWithEmail = vi.fn();
const mockGetPreferences              = vi.fn();

vi.mock('../services/notification.service.js', () => ({
  createNotificationWithEmail: mockCreateNotificationWithEmail,
  getPreferences:              mockGetPreferences,
}));

// Default pref: all enabled
mockGetPreferences.mockResolvedValue({
  success: true,
  data: { email_notifications: true, push_notifications: true, notification_types: {} },
});

// Default email fetch: return a fake email
mockSingle.mockResolvedValue({ data: { email: 'user@example.com' }, error: null });

// ─── markReminderSent ─────────────────────────────────────────────────────────

describe('markReminderSent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true on a successful insert', async () => {
    mockInsert.mockResolvedValueOnce({ error: null });
    const result = await markReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(true);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('returns false on a unique_violation (already sent)', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } });
    const result = await markReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(false);
  });

  it('throws on unexpected DB errors', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '42P01', message: 'relation missing' } });
    await expect(markReminderSent('booking-1', 'checkin_tenant')).rejects.toThrow('relation missing');
  });
});

// ─── isReminderSent ───────────────────────────────────────────────────────────

describe('isReminderSent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'row-1' }, error: null });
    const result = await isReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(true);
  });

  it('returns false when no row exists', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const result = await isReminderSent('booking-1', 'checkin_tenant');
    expect(result).toBe(false);
  });
});

// ─── runReminderScheduler ─────────────────────────────────────────────────────

/** Build a minimal booking row returned by the Supabase query mock. */
function makeBookingRow(id = 'booking-1') {
  return {
    id,
    tenant_id:  'tenant-1',
    check_in:   new Date(Date.now() + 12 * 3_600_000).toISOString().slice(0, 10),
    check_out:  new Date(Date.now() + 36 * 3_600_000).toISOString().slice(0, 10),
    total_price: 300,
    guest_count: 2,
    properties: { title: 'Beach House', owner_id: 'host-1' },
  };
}

describe('runReminderScheduler()', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Notification succeeds
    mockCreateNotificationWithEmail.mockResolvedValue({ success: true });

    // Preferences: all enabled, no quiet hours
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: { email_notifications: true, push_notifications: true, notification_types: {} },
    });

    // Email lookup
    mockSingle.mockResolvedValue({ data: { email: 'u@example.com' }, error: null });

    // isReminderSent: default = not yet sent
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it('sends reminders for a booking in the window and returns sent count > 0', async () => {
    const row = makeBookingRow();

    // check-in query
    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    // check-out query
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // markReminderSent: first call = new insert (tenant), second = new insert (host)
    mockInsert
      .mockResolvedValueOnce({ error: null }) // checkin_tenant
      .mockResolvedValueOnce({ error: null }); // checkin_host

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBeGreaterThan(0);
    expect(result.data!.errors).toBe(0);
  });

  it('skips reminders already sent (duplicate-proof across runs)', async () => {
    const row = makeBookingRow();

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Both inserts return unique_violation — already sent
    mockInsert
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } })
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    // Nothing new was sent — all skipped
    expect(result.data!.sent).toBe(0);
    expect(result.data!.skipped).toBeGreaterThan(0);
    // Notification service must NOT have been called
    expect(mockCreateNotificationWithEmail).not.toHaveBeenCalled();
  });

  it('returns 0 sent when no bookings are in the window', async () => {
    mockNot.mockResolvedValueOnce({ data: [], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBe(0);
    expect(result.data!.skipped).toBe(0);
  });

  it('respects user preference — skips if booking_reminder is disabled', async () => {
    const row = makeBookingRow('booking-pref');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Insert succeeds (not yet sent)
    mockInsert
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null });

    // Preferences: booking_reminder disabled for both users
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        email_notifications: true,
        push_notifications:  true,
        notification_types:  { booking_reminder: false },
      },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    // Marked as sent in DB but not actually delivered
    expect(mockCreateNotificationWithEmail).not.toHaveBeenCalled();
  });

  it('sends both check-in and check-out reminders in the same run', async () => {
    const checkInRow  = makeBookingRow('b-checkin');
    const checkOutRow = makeBookingRow('b-checkout');

    // check-in query returns one booking, check-out query returns another
    mockNot
      .mockResolvedValueOnce({ data: [checkInRow],  error: null })
      .mockResolvedValueOnce({ data: [checkOutRow], error: null });

    // Four inserts: tenant+host for checkin, tenant+host for checkout
    mockInsert
      .mockResolvedValue({ error: null });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBeGreaterThan(0);
  });

  it('counts errors without crashing when markReminderSent throws', async () => {
    const row = makeBookingRow('booking-err');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // Unexpected DB error
    mockInsert.mockResolvedValue({
      error: { code: '42P01', message: 'table missing' },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.errors).toBeGreaterThan(0);
  });

  it('prevents duplicate sends with concurrent scheduler invocations', async () => {
    const row = makeBookingRow('booking-concurrent');

    // Simulate two concurrent invocations querying the same booking
    mockNot
      .mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: [], error: null });

    // First invocation succeeds, second gets unique violation (race condition)
    mockInsert
      .mockResolvedValueOnce({ data: [{ id: 'reminder-1' }], error: null }) // A: tenant sent
      .mockResolvedValueOnce({ data: [{ id: 'reminder-2' }], error: null }) // A: host sent
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } }) // B: tenant already sent
      .mockResolvedValueOnce({ error: { code: '23505', message: 'unique' } }); // B: host already sent

    const resultA = await runReminderScheduler();
    const resultB = await runReminderScheduler();

    // First invocation sends reminders
    expect(resultA.data!.sent).toBeGreaterThan(0);
    // Second invocation skips (already sent)
    expect(resultB.data!.sent).toBe(0);
    expect(resultB.data!.skipped).toBeGreaterThan(0);

    // Notification service called only once per reminder
    expect(mockCreateNotificationWithEmail.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ─── getLeadTimeHours — env-driven configuration validation ──────────────────

describe('getLeadTimeHours()', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    // Restore the original env after each test so values don't leak.
    process.env.REMINDER_CHECKIN_HOURS  = ORIGINAL_ENV.REMINDER_CHECKIN_HOURS;
    process.env.REMINDER_CHECKOUT_HOURS = ORIGINAL_ENV.REMINDER_CHECKOUT_HOURS;
    if (ORIGINAL_ENV.REMINDER_CHECKIN_HOURS  === undefined) delete process.env.REMINDER_CHECKIN_HOURS;
    if (ORIGINAL_ENV.REMINDER_CHECKOUT_HOURS === undefined) delete process.env.REMINDER_CHECKOUT_HOURS;
  });

  it('returns the hard-coded defaults when env vars are unset', () => {
    delete process.env.REMINDER_CHECKIN_HOURS;
    delete process.env.REMINDER_CHECKOUT_HOURS;
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('accepts valid positive integer values from env', () => {
    process.env.REMINDER_CHECKIN_HOURS  = '48';
    process.env.REMINDER_CHECKOUT_HOURS = '6';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(48);
    expect(checkOut).toBe(6);
  });

  it('accepts valid positive fractional values from env', () => {
    process.env.REMINDER_CHECKIN_HOURS  = '0.5';
    process.env.REMINDER_CHECKOUT_HOURS = '1.5';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(0.5);
    expect(checkOut).toBe(1.5);
  });

  it('falls back to default when env var is zero', () => {
    process.env.REMINDER_CHECKIN_HOURS  = '0';
    process.env.REMINDER_CHECKOUT_HOURS = '0';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('falls back to default when env var is negative', () => {
    process.env.REMINDER_CHECKIN_HOURS  = '-5';
    process.env.REMINDER_CHECKOUT_HOURS = '-1';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('falls back to default when env var is NaN (non-numeric string)', () => {
    process.env.REMINDER_CHECKIN_HOURS  = 'badvalue';
    process.env.REMINDER_CHECKOUT_HOURS = 'alsowrong';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('falls back to default when env var is an empty string', () => {
    // Number('') === 0, which is not > 0, so the default must be used.
    process.env.REMINDER_CHECKIN_HOURS  = '';
    process.env.REMINDER_CHECKOUT_HOURS = '';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('falls back to default when env var is Infinity', () => {
    process.env.REMINDER_CHECKIN_HOURS  = 'Infinity';
    process.env.REMINDER_CHECKOUT_HOURS = 'Infinity';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);
    expect(checkOut).toBe(12);
  });

  it('returns only finite values — never NaN or Infinity', () => {
    const badValues = ['', '0', '-1', 'NaN', 'Infinity', '-Infinity', 'abc'];
    for (const v of badValues) {
      process.env.REMINDER_CHECKIN_HOURS  = v;
      process.env.REMINDER_CHECKOUT_HOURS = v;
      const { checkIn, checkOut } = getLeadTimeHours();
      expect(Number.isFinite(checkIn)).toBe(true);
      expect(Number.isFinite(checkOut)).toBe(true);
      expect(checkIn).toBeGreaterThan(0);
      expect(checkOut).toBeGreaterThan(0);
    }
  });

  it('invalid checkIn does not affect valid checkOut', () => {
    process.env.REMINDER_CHECKIN_HOURS  = '-99';
    process.env.REMINDER_CHECKOUT_HOURS = '6';
    const { checkIn, checkOut } = getLeadTimeHours();
    expect(checkIn).toBe(24);  // falls back
    expect(checkOut).toBe(6);  // valid, kept as-is
  });

  it('payment and dispute lead times default correctly', () => {
    delete process.env.REMINDER_PAYMENT_HOURS;
    delete process.env.REMINDER_DISPUTE_HOURS;
    const { payment, dispute } = getLeadTimeHours();
    expect(payment).toBe(48);
    expect(dispute).toBe(72);
  });

  it('accepts custom payment and dispute lead times from env', () => {
    process.env.REMINDER_PAYMENT_HOURS = '36';
    process.env.REMINDER_DISPUTE_HOURS = '96';
    const { payment, dispute } = getLeadTimeHours();
    expect(payment).toBe(36);
    expect(dispute).toBe(96);
    delete process.env.REMINDER_PAYMENT_HOURS;
    delete process.env.REMINDER_DISPUTE_HOURS;
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePrefs(
  start: string | null,
  end:   string | null,
  tz:    string | null = 'UTC',
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

function utcAt(hour: number, minute = 0): Date {
  const d = new Date('2027-01-15T00:00:00Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

// ─── isInQuietHours ───────────────────────────────────────────────────────────

describe('isInQuietHours()', () => {

  it('returns false when both fields are null', () => {
    expect(isInQuietHours(makePrefs(null, null))).toBe(false);
  });

  it('returns false when start is null', () => {
    expect(isInQuietHours(makePrefs(null, '08:00'))).toBe(false);
  });

  it('returns false when end is null', () => {
    expect(isInQuietHours(makePrefs('22:00', null))).toBe(false);
  });

  // ── Wrap-midnight window 22:00–08:00 ──────────────────────────────────────

  it('returns true at 23:00 UTC inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(23))).toBe(true);
  });

  it('returns true at 00:00 UTC (midnight) inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(0))).toBe(true);
  });

  it('returns true at 07:59 UTC inside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(7, 59))).toBe(true);
  });

  it('returns false at 08:00 UTC (end is exclusive) for 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(8, 0))).toBe(false);
  });

  it('returns false at 14:00 UTC outside a 22:00–08:00 window', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(14))).toBe(false);
  });

  it('returns true at the start boundary exactly (22:00)', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00'), utcAt(22, 0))).toBe(true);
  });

  // ── Same-day window 09:00–17:00 ───────────────────────────────────────────

  it('returns true at 12:00 UTC inside a 09:00–17:00 window', () => {
    expect(isInQuietHours(makePrefs('09:00', '17:00'), utcAt(12))).toBe(true);
  });

  it('returns false at 08:59 UTC before a 09:00–17:00 window', () => {
    expect(isInQuietHours(makePrefs('09:00', '17:00'), utcAt(8, 59))).toBe(false);
  });

  it('returns false at 17:00 UTC (end exclusive) for 09:00–17:00 window', () => {
    expect(isInQuietHours(makePrefs('09:00', '17:00'), utcAt(17, 0))).toBe(false);
  });

  // ── Invalid timezone — fail-open ─────────────────────────────────────────

  it('returns false for an unrecognised timezone string', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00', 'Not/Real'), utcAt(23))).toBe(false);
  });

  it('returns false for an empty timezone string', () => {
    expect(isInQuietHours(makePrefs('22:00', '08:00', ''), utcAt(23))).toBe(false);
  });
});

// ─── Scheduler respects quiet hours without consuming idempotency slot ────────

describe('runReminderScheduler() — quiet-hours deferral', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateNotificationWithEmail.mockResolvedValue({ success: true });
    mockSingle.mockResolvedValue({ data: { email: 'u@example.com' }, error: null });
  });

  it('does not mark reminder sent and skips delivery when user is in quiet hours', async () => {
    const row = makeBookingRow('booking-quiet');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // isReminderSent check → no row yet (maybeSingle returns null)
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    // Quiet window: '00:01'–'00:00' wraps midnight and covers all 24h except
    // the exact stroke of midnight — no fake clock needed.
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        email_notifications:  true,
        push_notifications:   true,
        notification_types:   {},
        quiet_hours_start:    '00:01',
        quiet_hours_end:      '00:00',
        quiet_hours_timezone: 'UTC',
      },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    // No reminders marked as sent — INSERT must NOT have been called
    expect(mockInsert).not.toHaveBeenCalled();
    // No notifications delivered
    expect(mockCreateNotificationWithEmail).not.toHaveBeenCalled();
    // Both tenant+host counted as skipped
    expect(result.data!.skipped).toBeGreaterThan(0);
    expect(result.data!.sent).toBe(0);
  });

  it('delivers and marks after quiet hours end', async () => {
    const row = makeBookingRow('booking-after-quiet');

    mockNot.mockResolvedValueOnce({ data: [row], error: null });
    mockNot.mockResolvedValueOnce({ data: [], error: null });

    // isReminderSent → no row
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    // markReminderSent succeeds
    mockInsert.mockResolvedValue({ error: null });

    // No quiet hours configured → should deliver
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        email_notifications:  true,
        push_notifications:   true,
        notification_types:   {},
        quiet_hours_start:    null,
        quiet_hours_end:      null,
        quiet_hours_timezone: null,
      },
    });

    const result = await runReminderScheduler();

    expect(result.success).toBe(true);
    expect(result.data!.sent).toBeGreaterThan(0);
    expect(mockCreateNotificationWithEmail).toHaveBeenCalled();
  });
});
