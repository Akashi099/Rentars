/**
 * Canonical booking-status semantics shared by every surface that decides
 * whether a stay occupies dates (availability, calendar, pricing, deletion).
 *
 * Keep these sets the single source of truth. Do not inline status lists in
 * services: divergent lists are how calendars and the booking endpoint came to
 * disagree about the same night.
 *
 * - RESERVING: the booking occupies its nights. Used for conflict checks.
 * - ACTIVE:    the booking still has unfinished obligations (not yet completed,
 *              cancelled or expired). Used to refuse destructive listing actions.
 *
 * `Expired` (abandoned holds) and `Cancelled` never reserve dates.
 */

export const RESERVING_BOOKING_STATUSES = [
  'Pending',
  'Confirmed',
  'Disputed',
  'Completed',
] as const;

export const ACTIVE_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Disputed'] as const;

export const NON_RESERVING_BOOKING_STATUSES = ['Cancelled', 'Expired'] as const;

export type BookingStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Disputed'
  | 'Completed'
  | 'Cancelled'
  | 'Expired';

export function reservesDates(status: string | null | undefined): boolean {
  return (RESERVING_BOOKING_STATUSES as readonly string[]).includes(status ?? '');
}

/** UTC calendar date (YYYY-MM-DD) for a Date or ISO string. Timezone-independent. */
export function toUtcDateOnly(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString().slice(0, 10);
}
