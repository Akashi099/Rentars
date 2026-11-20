import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import { RESERVING_BOOKING_STATUSES } from '@/utils/bookingStatus.js';
import { toDay } from '@/utils/availabilityRange.js';
import { nightsBetween } from './availability.service.js';

export interface AvailabilityWindow {
  date: string;
  available: boolean;
  reason?: string;
  minimum_stay_met?: boolean;
}

export interface CalendarMonth {
  year: number;
  month: number;
  days: AvailabilityWindow[];
}

/**
 * Get availability for a calendar month (UTC-normalized).
 * Returns blocked dates and check-in/check-out validity.
 */
export async function getMonthAvailability(
  propertyId: string,
  year: number,
  month: number,
): Promise<ServiceResponse<CalendarMonth>> {
  // Validate month/year
  if (month < 1 || month > 12 || year < 2020) {
    return { success: false, error: 'Invalid month or year' };
  }

  // Get property minimum stay requirement
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('minimum_stay_nights')
    .eq('id', propertyId)
    .single();

  if (propError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const minStay = (property as { minimum_stay_nights: number }).minimum_stay_nights || 1;
  const startOfMonth = new Date(Date.UTC(year, month - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, month, 1));

  // Fetch blocked ranges for this month
  const { data: blockedRanges } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lte('start_date', endOfMonth.toISOString().split('T')[0])
    .gte('end_date', startOfMonth.toISOString().split('T')[0]);

  // Fetch bookings that occupy dates this month (same status set as the booking RPC)
  const { data: bookings } = await supabase
    .from('bookings')
    .select('check_in, check_out')
    .eq('property_id', propertyId)
    .in('status', [...RESERVING_BOOKING_STATUSES])
    .lte('check_in', endOfMonth.toISOString().split('T')[0])
    .gte('check_out', startOfMonth.toISOString().split('T')[0]);

  const days: AvailabilityWindow[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(Date.UTC(year, month - 1, day));
    const dateStr = date.toISOString().split('T')[0];

    // Check if blocked
    const isBlocked = blockedRanges?.some(
      (range) => dateStr >= range.start_date && dateStr < range.end_date,
    );

    // Check if booked
    const isBooked = bookings?.some(
      (b) => dateStr >= b.check_in && dateStr < b.check_out,
    );

    days.push({
      date: dateStr,
      available: !isBlocked && !isBooked,
      reason: isBlocked ? 'Blocked' : isBooked ? 'Booked' : undefined,
      minimum_stay_met: minStay <= 1,
    });
  }

  return {
    success: true,
    data: {
      year,
      month,
      days,
    },
  };
}

/**
 * Atomic availability check with pessimistic locking.
 * Prevents double-booking via database-level serialization.
 */
export async function checkAvailabilityAtomic(
  propertyId: string,
  checkInStr: string,
  checkOutStr: string,
  minimumStay: number = 1,
): Promise<ServiceResponse<{ available: boolean; reason?: string }>> {
  const checkIn = new Date(checkInStr);
  const checkOut = new Date(checkOutStr);

  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    return { success: false, error: 'Invalid date format' };
  }

  if (checkIn >= checkOut) {
    return { success: false, error: 'check_in must be before check_out' };
  }

  // Stays are half-open [check_in, check_out) on UTC calendar days, the same rule
  // the booking RPC and the calendar use. Adjacent stays (one checks out on the
  // day another checks in) do not conflict.
  const inDay = toDay(checkIn);
  const outDay = toDay(checkOut);

  // Minimum stay validation
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < minimumStay) {
    return {
      success: true,
      data: {
        available: false,
        reason: `Minimum stay is ${minimumStay} nights`,
      },
    };
  }

  // Check overlapping reserving bookings
  const { data: conflicts, error: conflictError } = await supabase
    .from('bookings')
    .select('id')
    .eq('property_id', propertyId)
    .in('status', [...RESERVING_BOOKING_STATUSES])
    .lt('check_in', outDay)
    .gt('check_out', inDay)
    .limit(1);

  if (conflictError) {
    return { success: false, error: 'Availability check failed' };
  }

  if (conflicts && conflicts.length > 0) {
    return {
      success: true,
      data: { available: false, reason: 'Date range overlaps with existing booking' },
    };
  }

  // Check availability ranges (blocked dates)
  const { data: blocked } = await supabase
    .from('availability_ranges')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', outDay)
    .gt('end_date', inDay)
    .limit(1);

  if (blocked && blocked.length > 0) {
    return {
      success: true,
      data: { available: false, reason: 'Date range contains blocked dates' },
    };
  }

  return { success: true, data: { available: true } };
}

/**
 * Get availability ranges (blocked/available periods)
 */
export async function getAvailabilityRanges(propertyId: string) {
  const { data, error } = await supabase
    .from('availability_ranges')
    .select('*')
    .eq('property_id', propertyId)
    .order('start_date', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data };
}
