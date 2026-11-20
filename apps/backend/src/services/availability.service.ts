import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import { RESERVING_BOOKING_STATUSES } from '@/utils/bookingStatus.js';
import { toDay } from '@/utils/availabilityRange.js';

export interface AvailabilityRange {
  id: string;
  property_id: string;
  start_date: string;
  end_date: string;
  is_available: boolean;
  reason?: string;
  created_at?: string;
}

export interface BlockRangeInput {
  start_date: string;
  end_date: string;
  reason?: string;
}

export interface PropertySettings {
  min_stay_nights: number;
  max_stay_nights?: number | null;
}

export interface AvailabilityWindow {
  property_id: string;
  check_in: string;
  check_out: string;
  nights: number;
  is_available: boolean;
  unavailable_reason?: string;
  settings: PropertySettings;
}

/** Validate ISO date string */
function parseDate(value: string): Date | null {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Returns number of nights between two dates using UTC calendar boundaries, immune to DST offsets. */
export function nightsBetween(checkIn: Date, checkOut: Date): number {
  const msPerDay = 86400000;
  const inDay = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  const outDay = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  return (outDay - inDay) / msPerDay;
}

export async function getAvailabilityRanges(
  propertyId: string,
): Promise<ServiceResponse<AvailabilityRange[]>> {
  const { data, error } = await supabase
    .from('availability_ranges')
    .select('*')
    .eq('property_id', propertyId)
    .order('start_date', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AvailabilityRange[] };
}

export async function blockAvailabilityRange(
  propertyId: string,
  ownerId: string,
  input: BlockRangeInput,
): Promise<ServiceResponse<AvailabilityRange>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property) return { success: false, error: 'Property not found' };
  if ((property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const startDate = parseDate(input.start_date);
  const endDate = parseDate(input.end_date);

  if (!startDate || !endDate) return { success: false, error: 'Invalid date format' };
  if (startDate >= endDate) return { success: false, error: 'start_date must be before end_date' };

  // Reject if any reserving booking covers part of this range. Uses the same
  // status set as the booking RPC and the calendar, so a range cannot be blocked
  // over a Disputed or Completed stay that still occupies the dates.
  const { data: conflictingBookings, error: conflictError } = await supabase
    .from('bookings')
    .select('id')
    .eq('property_id', propertyId)
    .in('status', [...RESERVING_BOOKING_STATUSES])
    .lt('check_in', toDay(endDate))
    .gt('check_out', toDay(startDate))
    .limit(1);

  if (conflictError) return { success: false, error: conflictError.message };

  if (conflictingBookings && conflictingBookings.length > 0) {
    return {
      success: false,
      error: 'Cannot block this range: an existing booking overlaps these dates',
    };
  }

  const { data, error } = await supabase
    .from('availability_ranges')
    .insert({
      property_id: propertyId,
      start_date: input.start_date,
      end_date: input.end_date,
      is_available: false,
      reason: input.reason,
      blocked_by: ownerId,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AvailabilityRange };
}

export async function deleteAvailabilityRange(
  propertyId: string,
  rangeId: string,
  ownerId: string,
): Promise<ServiceResponse<void>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const { error } = await supabase
    .from('availability_ranges')
    .delete()
    .eq('id', rangeId)
    .eq('property_id', propertyId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Check whether a date range is free of manual blocks for a property.
 * Does NOT check booking conflicts — use checkDateRangeAvailability for full check.
 */
export async function isDateRangeAvailable(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<boolean> {
  const checkInDate = parseDate(checkIn);
  const checkOutDate = parseDate(checkOut);
  if (!checkInDate || !checkOutDate || checkOutDate <= checkInDate) return false;

  const { data } = await supabase
    .from('availability_ranges')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOut)
    .gt('end_date', checkIn)
    .limit(1);

  return !data || data.length === 0;
}

/**
  * Full availability check: validates dates, min/max stay, blocked ranges, and booking conflicts.
  * Returns an AvailabilityWindow with full details.
  */
export async function checkDateRangeAvailability(
  propertyId: string,
  checkIn: string,
  checkOut: string,
  excludeBookingId?: string,
): Promise<ServiceResponse<AvailabilityWindow>> {
  const checkInDate = parseDate(checkIn);
  const checkOutDate = parseDate(checkOut);

  if (!checkInDate || !checkOutDate) {
    return { success: false, error: 'Invalid date format' };
  }
  if (checkInDate >= checkOutDate) {
    return { success: false, error: 'check_in must be before check_out' };
  }

  const nights = nightsBetween(checkInDate, checkOutDate);
  // Queries compare calendar days in UTC, so a timestamp input cannot shift a stay.
  const checkInDay = toDay(checkInDate);
  const checkOutDay = toDay(checkOutDate);

  // Load settings (min/max stay)
  const { data: settingsRow } = await supabase
    .from('property_settings')
    .select('min_stay_nights, max_stay_nights')
    .eq('property_id', propertyId)
    .single();

  const settings: PropertySettings = {
    min_stay_nights: (settingsRow as PropertySettings | null)?.min_stay_nights ?? 1,
    max_stay_nights: (settingsRow as PropertySettings | null)?.max_stay_nights ?? null,
  };

  if (nights < settings.min_stay_nights) {
    return {
      success: true,
      data: {
        property_id: propertyId,
        check_in: checkIn,
        check_out: checkOut,
        nights,
        is_available: false,
        unavailable_reason: `Minimum stay is ${settings.min_stay_nights} night(s)`,
        settings,
      },
    };
  }

  if (settings.max_stay_nights && nights > settings.max_stay_nights) {
    return {
      success: true,
      data: {
        property_id: propertyId,
        check_in: checkIn,
        check_out: checkOut,
        nights,
        is_available: false,
        unavailable_reason: `Maximum stay is ${settings.max_stay_nights} night(s)`,
        settings,
      },
    };
  }

  // Check manual blocked ranges
  const { data: blockedRanges } = await supabase
    .from('availability_ranges')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOutDay)
    .gt('end_date', checkInDay)
    .limit(1);

  if (blockedRanges && blockedRanges.length > 0) {
    return {
      success: true,
      data: {
        property_id: propertyId,
        check_in: checkIn,
        check_out: checkOut,
        nights,
        is_available: false,
        unavailable_reason: 'Dates are blocked by the owner',
        settings,
      },
    };
  }

  // Check booking conflicts (active bookings, not cancelled)
  let conflictQuery = supabase
    .from('bookings')
    .select('id')
    .eq('property_id', propertyId)
    .in('status', [...RESERVING_BOOKING_STATUSES])
    .lt('check_in', checkOutDay)
    .gt('check_out', checkInDay)
    .limit(1);

  if (excludeBookingId) {
    conflictQuery = conflictQuery.neq('id', excludeBookingId);
  }

  const { data: conflictingBookings } = await conflictQuery;

  if (conflictingBookings && conflictingBookings.length > 0) {
    return {
      success: true,
      data: {
        property_id: propertyId,
        check_in: checkIn,
        check_out: checkOut,
        nights,
        is_available: false,
        unavailable_reason: 'Property already booked for these dates',
        settings,
      },
    };
  }

  return {
    success: true,
    data: {
      property_id: propertyId,
      check_in: checkIn,
      check_out: checkOut,
      nights,
      is_available: true,
      settings,
    },
  };
}
