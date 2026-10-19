/**
 * Booking reminder service.
 *
 * Finds bookings whose check-in, check-out, payment deadline, or unresolved
 * dispute falls within a configurable lead-time window and sends a
 * `booking_reminder` notification to the relevant parties (tenant + host),
 * respecting per-user channel preferences and quiet-hour windows.
 *
 * Idempotent: a `booking_reminders` row is inserted (or detected via the
 * unique constraint) before sending so the job can run repeatedly without
 * ever delivering a duplicate.
 *
 * Quiet hours: if the recipient's current local time falls inside their
 * configured quiet window the reminder is deferred — the row is NOT marked
 * sent so the next scheduler run will retry delivery.
 *
 * Configuration (env):
 *   REMINDER_CHECKIN_HOURS         — hours before check-in  (default: 24)
 *   REMINDER_CHECKOUT_HOURS        — hours before check-out (default: 12)
 *   REMINDER_PAYMENT_HOURS         — hours before payment deadline (default: 48)
 *   REMINDER_DISPUTE_HOURS         — hours after dispute raised (default: 72)
 */

import { supabase } from '@/config/supabase.js';
import { createNotificationWithEmail, getPreferences } from './notification.service.js';
import type { NotificationPreferences } from './notification.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderType =
  | 'checkin_tenant'
  | 'checkin_host'
  | 'checkout_tenant'
  | 'checkout_host'
  | 'payment_deadline_tenant'
  | 'dispute_unresolved_tenant'
  | 'dispute_unresolved_host';

export interface ReminderResult {
  sent:     number;
  skipped:  number;
  errors:   number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const LEAD_TIME_DEFAULTS = {
  checkIn:  24,
  checkOut: 12,
  payment:  48,
  dispute:  72,
} as const;

/**
 * Parse and validate lead-time hours from the environment.
 *
 * Rules:
 *  - The raw value is converted with Number().
 *  - Values that are NaN, non-finite, zero, or negative are invalid and
 *    replaced with the hard-coded default.
 *  - A positive finite value (including fractional hours) is accepted as-is.
 */
export function getLeadTimeHours(): {
  checkIn: number; checkOut: number; payment: number; dispute: number;
} {
  const parse = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw ?? fallback);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    checkIn:  parse(process.env.REMINDER_CHECKIN_HOURS,  LEAD_TIME_DEFAULTS.checkIn),
    checkOut: parse(process.env.REMINDER_CHECKOUT_HOURS, LEAD_TIME_DEFAULTS.checkOut),
    payment:  parse(process.env.REMINDER_PAYMENT_HOURS,  LEAD_TIME_DEFAULTS.payment),
    dispute:  parse(process.env.REMINDER_DISPUTE_HOURS,  LEAD_TIME_DEFAULTS.dispute),
  };
}

// ─── Quiet-hour helpers ───────────────────────────────────────────────────────

/**
 * Return true if `now` falls inside the user's configured quiet window.
 *
 * The window is evaluated in the user's `quiet_hours_timezone` (defaults to
 * UTC). It handles wrap-around correctly, e.g. 22:00–08:00 spans midnight.
 *
 * Returns false (never suppresses) when:
 *  - `quiet_hours_start` or `quiet_hours_end` is absent/null
 *  - The supplied timezone string is invalid (fail-open: deliver rather than
 *    permanently suppress)
 */
export function isInQuietHours(
  prefs: NotificationPreferences,
  now: Date = new Date(),
): boolean {
  const start = prefs.quiet_hours_start;
  const end   = prefs.quiet_hours_end;
  if (!start || !end) return false;

  const tz = prefs.quiet_hours_timezone ?? 'UTC';

  let currentHour:   number;
  let currentMinute: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour:     'numeric',
      minute:   'numeric',
      hour12:   false,
    }).formatToParts(now);
    // Intl may return '24' for midnight in some environments; normalise with % 24.
    currentHour   = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10) % 24;
    currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  } catch {
    return false; // invalid timezone — fail-open: do not suppress delivery
  }

  const toMinutes = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const nowMin   = currentHour * 60 + currentMinute;
  const startMin = toMinutes(start);
  const endMin   = toMinutes(end);

  if (startMin <= endMin) {
    // Same-day window, e.g. 08:00–20:00
    return nowMin >= startMin && nowMin < endMin;
  } else {
    // Wraps midnight, e.g. 22:00–08:00
    return nowMin >= startMin || nowMin < endMin;
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Mark a reminder as sent. Returns false if already sent (unique violation),
 * true on success, throws on unexpected errors.
 *
 * Uses atomic INSERT … ON CONFLICT … DO NOTHING to prevent race conditions
 * when multiple scheduler invocations run concurrently.
 */
export async function markReminderSent(
  bookingId: string,
  reminderType: ReminderType,
): Promise<boolean> {
  const { error } = await supabase
    .from('booking_reminders')
    .insert({ booking_id: bookingId, reminder_type: reminderType });

  if (!error) return true;
  if (error.code === '23505') return false; // unique_violation — already sent
  throw new Error(error.message);
}

/**
 * Check whether a reminder has already been sent (without inserting).
 */
export async function isReminderSent(
  bookingId: string,
  reminderType: ReminderType,
): Promise<boolean> {
  const { data } = await supabase
    .from('booking_reminders')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('reminder_type', reminderType)
    .maybeSingle();

  return !!data;
}

async function getUserEmail(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('users')
    .select('email')
    .eq('id', userId)
    .single();
  return (data as { email?: string } | null)?.email ?? null;
}

// ─── Delivery helper ──────────────────────────────────────────────────────────

/**
 * Attempt to deliver a `booking_reminder` notification to `userId`.
 *
 * Returns:
 *  - `true`  — notification was created successfully
 *  - `false` — the notification type is disabled for this user (permanent skip)
 *
 * Quiet-hours checking is intentionally NOT done here; it is performed by the
 * caller BEFORE calling `markReminderSent` so that quiet-hour deferrals never
 * consume the idempotency slot.
 */
async function sendReminderIfAllowed(
  userId:    string,
  bookingId: string,
  data:      Record<string, unknown>,
): Promise<boolean> {
  const prefs = await getPreferences(userId);
  if (prefs.success && prefs.data) {
    if (prefs.data.notification_types['booking_reminder'] === false) return false;
  }

  const email  = await getUserEmail(userId);
  const result = await createNotificationWithEmail(userId, 'booking_reminder', {
    ...data,
    booking_id: bookingId,
    userEmail:  email ?? undefined,
  });

  return result.success;
}

// ─── Per-user send gate (quiet hours + mark + deliver) ────────────────────────

/**
 * Attempt to send one reminder to one user.
 *
 * Flow:
 *  1. Check whether this reminder has already been sent (read-only).
 *  2. Fetch preferences; if quiet hours are active, defer (do NOT mark sent).
 *  3. Atomically mark as sent via unique-constraint INSERT.
 *  4. Deliver the notification.
 *
 * Mutates `result` in place.
 */
async function processOneReminder(
  bookingId:    string,
  userId:       string,
  reminderType: ReminderType,
  data:         Record<string, unknown>,
  result:       ReminderResult,
): Promise<void> {
  const alreadySent = await isReminderSent(bookingId, reminderType);
  if (alreadySent) {
    result.skipped++;
    return;
  }

  // Quiet-hour check before consuming the idempotency slot
  const prefs = await getPreferences(userId);
  if (prefs.success && prefs.data && isInQuietHours(prefs.data)) {
    result.skipped++; // defer — scheduler will retry on the next pass
    return;
  }

  // Atomic gate: mark first to prevent concurrent duplicate delivery
  const marked = await markReminderSent(bookingId, reminderType);
  if (!marked) {
    result.skipped++; // lost the race to a concurrent scheduler instance
    return;
  }

  const sent = await sendReminderIfAllowed(userId, bookingId, data);
  sent ? result.sent++ : result.skipped++;
}

// ─── Reminder processors ──────────────────────────────────────────────────────

async function processCheckInReminders(
  leadHours: number,
  result:    ReminderResult,
): Promise<void> {
  const now       = new Date();
  const windowEnd = new Date(now.getTime() + leadHours * 3_600_000);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count,
       properties ( title, owner_id )`,
    )
    .gte('check_in', now.toISOString().slice(0, 10))
    .lte('check_in', windowEnd.toISOString().slice(0, 10))
    .not('status', 'eq', 'Cancelled');

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const ownerId       = booking.properties?.owner_id;
    const notifData     = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
    };

    try {
      await processOneReminder(booking.id, booking.tenant_id, 'checkin_tenant',
        { ...notifData, role: 'tenant', event: 'check_in' }, result);
    } catch { result.errors++; }

    if (ownerId) {
      try {
        await processOneReminder(booking.id, ownerId, 'checkin_host',
          { ...notifData, role: 'host', event: 'check_in' }, result);
      } catch { result.errors++; }
    }
  }
}

async function processCheckOutReminders(
  leadHours: number,
  result:    ReminderResult,
): Promise<void> {
  const now       = new Date();
  const windowEnd = new Date(now.getTime() + leadHours * 3_600_000);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count,
       properties ( title, owner_id )`,
    )
    .gte('check_out', now.toISOString().slice(0, 10))
    .lte('check_out', windowEnd.toISOString().slice(0, 10))
    .not('status', 'eq', 'Cancelled');

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const ownerId       = booking.properties?.owner_id;
    const notifData     = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
    };

    try {
      await processOneReminder(booking.id, booking.tenant_id, 'checkout_tenant',
        { ...notifData, role: 'tenant', event: 'check_out' }, result);
    } catch { result.errors++; }

    if (ownerId) {
      try {
        await processOneReminder(booking.id, ownerId, 'checkout_host',
          { ...notifData, role: 'host', event: 'check_out' }, result);
      } catch { result.errors++; }
    }
  }
}

/**
 * Remind tenants whose payment deadline is approaching.
 *
 * Targets bookings in `Pending` status whose `created_at` is more than
 * (48 - leadHours) hours in the past, meaning the deadline is within the
 * lead-time window. Adjust `REMINDER_PAYMENT_HOURS` to control how early
 * the reminder fires.
 */
async function processPaymentDeadlineReminders(
  leadHours: number,
  result:    ReminderResult,
): Promise<void> {
  // Payment deadline = 48 h after booking creation.
  // We fire a reminder when the deadline is ≤ leadHours away.
  const deadlineWindowStart = new Date(Date.now() - (48 - leadHours) * 3_600_000);
  const deadlineWindowEnd   = new Date(Date.now() - (48 - leadHours - 1) * 3_600_000);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count, created_at,
       properties ( title, owner_id )`,
    )
    .eq('status', 'Pending')
    .gte('created_at', deadlineWindowStart.toISOString())
    .lte('created_at', deadlineWindowEnd.toISOString());

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number; created_at: string;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const notifData     = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
      event:      'payment_deadline',
    };

    try {
      await processOneReminder(booking.id, booking.tenant_id, 'payment_deadline_tenant',
        { ...notifData, role: 'tenant' }, result);
    } catch { result.errors++; }
  }
}

/**
 * Remind both parties of unresolved disputes that have been open for longer
 * than `leadHours`.
 */
async function processDisputeReminders(
  leadHours: number,
  result:    ReminderResult,
): Promise<void> {
  const openSince = new Date(Date.now() - leadHours * 3_600_000);

  const { data: bookings, error } = await supabase
    .from('bookings')
    .select(
      `id, tenant_id, check_in, check_out, total_price, guest_count,
       properties ( title, owner_id )`,
    )
    .eq('status', 'Disputed')
    .lte('updated_at', openSince.toISOString());

  if (error || !bookings) return;

  for (const booking of bookings as Array<{
    id: string; tenant_id: string; check_in: string; check_out: string;
    total_price: number; guest_count: number;
    properties: { title: string; owner_id: string } | null;
  }>) {
    const propertyTitle = booking.properties?.title ?? 'your rental';
    const ownerId       = booking.properties?.owner_id;
    const notifData     = {
      propertyTitle,
      checkIn:    booking.check_in,
      checkOut:   booking.check_out,
      totalPrice: booking.total_price,
      guestCount: booking.guest_count,
      event:      'dispute_unresolved',
    };

    try {
      await processOneReminder(booking.id, booking.tenant_id, 'dispute_unresolved_tenant',
        { ...notifData, role: 'tenant' }, result);
    } catch { result.errors++; }

    if (ownerId) {
      try {
        await processOneReminder(booking.id, ownerId, 'dispute_unresolved_host',
          { ...notifData, role: 'host' }, result);
      } catch { result.errors++; }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run one pass of the reminder scheduler.
 * Designed to be called on a timer (e.g. every hour).
 */
export async function runReminderScheduler(): Promise<ServiceResponse<ReminderResult>> {
  const { checkIn, checkOut, payment, dispute } = getLeadTimeHours();
  const result: ReminderResult = { sent: 0, skipped: 0, errors: 0 };

  await processCheckInReminders(checkIn, result);
  await processCheckOutReminders(checkOut, result);
  await processPaymentDeadlineReminders(payment, result);
  await processDisputeReminders(dispute, result);

  return { success: true, data: result };
}
