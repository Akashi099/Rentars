/**
 * Date-range helpers for availability, calendar and pricing (#925).
 *
 * Canonical model, shared by every consumer:
 *  - Stays and blocks are half-open intervals [start, end). The check-in night is
 *    included; the check-out day is not. So a stay ending on 10 May and a stay
 *    starting on 10 May do not overlap.
 *  - Dates are calendar dates (YYYY-MM-DD) interpreted in UTC. A timestamp is
 *    reduced to its UTC date before comparison, so a local timezone can never
 *    move a booked night onto a neighbouring day.
 *  - Which booking statuses occupy dates is defined in utils/bookingStatus.ts.
 *    The database exclusion constraint mirrors it (migration 00073).
 */

import { toUtcDateOnly } from './bookingStatus.js';

/** Calendar date string (YYYY-MM-DD) for a Date or ISO timestamp, in UTC. */
export function toDay(value: Date | string): string {
  return toUtcDateOnly(value);
}

/**
 * Whether two half-open date ranges share at least one night.
 * Inputs are YYYY-MM-DD strings, which compare correctly as text.
 */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Whether a single night (YYYY-MM-DD) falls inside [start, end). */
export function nightInRange(night: string, start: string, end: string): boolean {
  return night >= start && night < end;
}

/**
 * The nights of a stay, as YYYY-MM-DD strings in UTC. Check-out is excluded.
 * Returns [] when check-out is not after check-in.
 */
export function enumerateNights(checkIn: Date | string, checkOut: Date | string): string[] {
  const start = Date.parse(toDay(checkIn));
  const end = Date.parse(toDay(checkOut));
  const nights: string[] = [];
  for (let t = start; t < end; t += 86_400_000) {
    nights.push(new Date(t).toISOString().slice(0, 10));
  }
  return nights;
}
