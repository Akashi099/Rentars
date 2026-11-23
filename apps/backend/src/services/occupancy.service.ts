/**
 * Occupancy heatmap service.
 *
 * Returns the daily availability status for a property over a date range.
 * Status values:
 *   'booked'    — an active booking (Pending or Confirmed) covers this day
 *   'blocked'   — a manual availability block covers this day
 *   'available' — neither booked nor blocked
 *
 * Host-only: the controller enforces that only the property owner may call
 * this endpoint.
 */

import { supabase } from '@/config/supabase.js';
import { RESERVING_BOOKING_STATUSES } from './booking.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DayStatus = 'booked' | 'blocked' | 'available';

export interface DayEntry {
  date:   string;     // ISO YYYY-MM-DD
  status: DayStatus;
}

export interface OccupancyHeatmapResult {
  propertyId: string;
  from:       string;
  to:         string;
  days:       DayEntry[];
  summary: {
    booked:    number;
    blocked:   number;
    available: number;
    total:     number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return every calendar date (YYYY-MM-DD) in the range [from, to] inclusive. */
function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(from + 'T00:00:00Z');
  const end    = new Date(to   + 'T00:00:00Z');
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Return true if [rangeStart, rangeEnd) overlaps with the given date. */
function coversDate(rangeStart: string, rangeEnd: string, date: string): boolean {
  // check_in <= date < check_out  (check_out is the departure day, not a night)
  return rangeStart <= date && date < rangeEnd;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Build a per-day status map for a property over the requested horizon.
 *
 * @param propertyId  - UUID of the property
 * @param from        - ISO date string, inclusive start
 * @param to          - ISO date string, inclusive end
 */
export async function getOccupancyHeatmap(
  propertyId: string,
  from:        string,
  to:          string,
): Promise<ServiceResponse<OccupancyHeatmapResult>> {
  if (!propertyId) return { success: false, error: 'propertyId is required' };

  const fromDate = new Date(from + 'T00:00:00Z');
  const toDate   = new Date(to   + 'T00:00:00Z');

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return { success: false, error: 'Invalid date format. Use YYYY-MM-DD.' };
  }

  if (fromDate > toDate) {
    return { success: false, error: '`from` must be on or before `to`' };
  }

  // Cap horizon at 366 days to prevent accidental huge queries
  const diffDays = Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000);
  if (diffDays > 366) {
    return { success: false, error: 'Date range must not exceed 366 days' };
  }

  // ── Fetch bookings that overlap [from, to] ──────────────────────────────
  // Only statuses that actually reserve inventory (Pending, Confirmed) are
  // shown as booked; Expired/Cancelled holds release their dates.
  const { data: bookings, error: bErr } = await supabase
    .from('bookings')
    .select('check_in, check_out, status')
    .eq('property_id', propertyId)
    .in('status', RESERVING_BOOKING_STATUSES)
    .lt('check_in', to)       // starts before the window ends
    .gt('check_out', from);   // ends after the window starts

  if (bErr) return { success: false, error: bErr.message };

  // ── Fetch manual availability blocks that overlap [from, to] ──────────
  const { data: blocks, error: blErr } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', to)
    .gt('end_date', from);

  if (blErr) return { success: false, error: blErr.message };

  // ── Build sets for O(1) lookup ─────────────────────────────────────────
  const bookedDays  = new Set<string>();
  const blockedDays = new Set<string>();

  for (const b of (bookings ?? []) as { check_in: string; check_out: string; status: string }[]) {
    for (const d of dateRange(
      b.check_in  > from ? b.check_in  : from,
      b.check_out < to   ? b.check_out : to,
    )) {
      if (coversDate(b.check_in, b.check_out, d)) bookedDays.add(d);
    }
  }

  for (const bl of (blocks ?? []) as { start_date: string; end_date: string }[]) {
    for (const d of dateRange(
      bl.start_date > from ? bl.start_date : from,
      bl.end_date   < to   ? bl.end_date   : to,
    )) {
      if (coversDate(bl.start_date, bl.end_date, d)) blockedDays.add(d);
    }
  }

  // ── Assemble per-day entries ────────────────────────────────────────────
  const allDates = dateRange(from, to);
  const days: DayEntry[] = allDates.map((date) => {
    let status: DayStatus = 'available';
    if (bookedDays.has(date))       status = 'booked';
    else if (blockedDays.has(date)) status = 'blocked';
    return { date, status };
  });

  const summary = {
    booked:    days.filter((d) => d.status === 'booked').length,
    blocked:   days.filter((d) => d.status === 'blocked').length,
    available: days.filter((d) => d.status === 'available').length,
    total:     days.length,
  };

  return {
    success: true,
    data: { propertyId, from, to, days, summary },
  };
}
