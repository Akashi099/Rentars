import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import { signQuoteToken, verifyQuoteToken } from '@/utils/quoteToken.js';

const PLATFORM_FEE_PCT = 0.05;
/** How long a quote (and its token) stays valid before the client must re-quote. */
export const QUOTE_TTL_MS = 15 * 60 * 1000;
const MIN_PRICE_MULTIPLIER = 0.1;
const MAX_PRICE_MULTIPLIER = 10;
const MIN_NIGHTLY_PRICE = 1;
const MAX_NIGHTLY_PRICE = 10_000;

export interface SeasonalPricing {
  id: string;
  property_id: string;
  name: string;
  start_date: string;
  end_date: string;
  price_multiplier: number;
  created_at?: string;
}

export interface SpecialEvent {
  id: string;
  property_id: string;
  name: string;
  start_date: string;
  end_date: string;
  price_multiplier?: number;
  is_blocked: boolean;
  created_at?: string;
}

export interface DayPricing {
  date: string;
  price: number;
  is_available: boolean;
  reason?: string;
}

export interface PriceQuote {
  base_nightly_rate: number;
  nights: number;
  subtotal: number;
  dynamic_adjustments: number;
  platform_fee_pct: number;
  platform_fee: number;
  total: number;
  breakdown: DayPricing[];
  timezone?: string;
  currency?: string;
  version?: string;
  expires_at?: string;
  /** True when every requested night is bookable. */
  available: boolean;
  /** Signed binding of this total to its inputs; null when signing is not configured. */
  quote_token: string | null;
  unavailable_intervals?: Array<{ start: string; end: string; reason: string }>;
}

/**
 * Calculate price for a date range considering seasonal pricing,
 * special events, bookings, and availability blocks. All dates normalized to UTC.
 */
export async function calculateRangePrice(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<ServiceResponse<{ total: number; breakdown: DayPricing[] }>> {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);

  if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
    return { success: false, error: 'Invalid date format' };
  }

  // Fetch property base price
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('base_price_per_night')
    .eq('id', propertyId)
    .single();

  if (propError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const basePrice = (property as { base_price_per_night: number }).base_price_per_night;

  // Fetch seasonal pricing
  const { data: seasonalRates } = await supabase
    .from('seasonal_pricing')
    .select('*')
    .eq('property_id', propertyId)
    .lte('start_date', checkOut)
    .gte('end_date', checkIn);

  // Fetch special events
  const { data: events } = await supabase
    .from('special_events')
    .select('*')
    .eq('property_id', propertyId)
    .lte('start_date', checkOut)
    .gte('end_date', checkIn);

  // Fetch bookings that conflict with the date range
  const { data: bookings } = await supabase
    .from('bookings')
    .select('check_in, check_out')
    .eq('property_id', propertyId)
    .neq('status', 'Cancelled')
    .lt('check_in', checkOut)
    .gt('check_out', checkIn);

  // Fetch availability blocks
  const { data: blocks } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOut)
    .gt('end_date', checkIn);

  const breakdown: DayPricing[] = [];
  let total = 0;

  for (let d = new Date(checkInDate); d < checkOutDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];

    // Check if blocked by special event
    const blockedEvent = events?.find(
      (e) => e.is_blocked && dateStr >= e.start_date && dateStr < e.end_date,
    );

    if (blockedEvent) {
      breakdown.push({
        date: dateStr,
        price: 0,
        is_available: false,
        reason: `Blocked: ${blockedEvent.name}`,
      });
      continue;
    }

    // Check if booked by another guest
    const isBooked = bookings?.some(
      (b) => dateStr >= b.check_in && dateStr < b.check_out,
    );

    if (isBooked) {
      breakdown.push({
        date: dateStr,
        price: 0,
        is_available: false,
        reason: 'Already booked',
      });
      continue;
    }

    // Check if host blocked availability
    const isBlocked = blocks?.some(
      (b) => dateStr >= b.start_date && dateStr < b.end_date,
    );

    if (isBlocked) {
      breakdown.push({
        date: dateStr,
        price: 0,
        is_available: false,
        reason: 'Host blocked',
      });
      continue;
    }

    // Calculate multiplier from seasonal pricing + special events
    let multiplier = 1;

    const seasonalRate = seasonalRates?.find(
      (r) => dateStr >= r.start_date && dateStr < r.end_date,
    );
    if (seasonalRate) {
      multiplier *= seasonalRate.price_multiplier;
    }

    const event = events?.find(
      (e) => !e.is_blocked && dateStr >= e.start_date && dateStr < e.end_date,
    );
    if (event?.price_multiplier) {
      multiplier *= event.price_multiplier;
    }

    const dayPrice = basePrice * multiplier;
    total += dayPrice;

    breakdown.push({
      date: dateStr,
      price: dayPrice,
      is_available: true,
    });
  }

  return { success: true, data: { total, breakdown } };
}

/**
 * Get all seasonal pricing for a property
 */
export async function getSeasonalPricing(
  propertyId: string,
): Promise<ServiceResponse<SeasonalPricing[]>> {
  const { data, error } = await supabase
    .from('seasonal_pricing')
    .select('*')
    .eq('property_id', propertyId)
    .order('start_date', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as SeasonalPricing[] };
}

/**
 * Create seasonal pricing rule
 */
export async function createSeasonalPricing(
  propertyId: string,
  ownerId: string,
  input: Omit<SeasonalPricing, 'id' | 'property_id' | 'created_at'>,
): Promise<ServiceResponse<SeasonalPricing>> {
  if (
    input.price_multiplier < MIN_PRICE_MULTIPLIER ||
    input.price_multiplier > MAX_PRICE_MULTIPLIER
  ) {
    return {
      success: false,
      error: `price_multiplier must be between ${MIN_PRICE_MULTIPLIER} and ${MAX_PRICE_MULTIPLIER}`,
    };
  }
  if (new Date(input.start_date) >= new Date(input.end_date)) {
    return { success: false, error: 'start_date must be before end_date' };
  }

  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  const { data, error } = await supabase
    .from('seasonal_pricing')
    .insert({ property_id: propertyId, ...input })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as SeasonalPricing };
}

/**
 * Delete seasonal pricing rule
 */
export async function deleteSeasonalPricing(
  propertyId: string,
  pricingId: string,
  ownerId: string,
): Promise<ServiceResponse<void>> {
  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  const { error } = await supabase
    .from('seasonal_pricing')
    .delete()
    .eq('id', pricingId)
    .eq('property_id', propertyId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Create special event (holiday pricing or block)
 */
export async function createSpecialEvent(
  propertyId: string,
  ownerId: string,
  input: Omit<SpecialEvent, 'id' | 'property_id' | 'created_at'>,
): Promise<ServiceResponse<SpecialEvent>> {
  if (
    input.price_multiplier !== undefined &&
    (input.price_multiplier < MIN_PRICE_MULTIPLIER || input.price_multiplier > MAX_PRICE_MULTIPLIER)
  ) {
    return {
      success: false,
      error: `price_multiplier must be between ${MIN_PRICE_MULTIPLIER} and ${MAX_PRICE_MULTIPLIER}`,
    };
  }
  if (new Date(input.start_date) >= new Date(input.end_date)) {
    return { success: false, error: 'start_date must be before end_date' };
  }

  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  const { data, error } = await supabase
    .from('special_events')
    .insert({ property_id: propertyId, ...input })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as SpecialEvent };
}

/**
 * Delete special event
 */
export async function deleteSpecialEvent(
  propertyId: string,
  eventId: string,
  ownerId: string,
): Promise<ServiceResponse<void>> {
  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  const { error } = await supabase
    .from('special_events')
    .delete()
    .eq('id', eventId)
    .eq('property_id', propertyId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Preview per-day effective prices across a date range with min/max bounds enforced.
 * Intended for hosts to validate their rule configuration before publishing.
 */
export async function previewPricing(
  propertyId: string,
  start: string,
  end: string,
): Promise<ServiceResponse<{ total: number; breakdown: DayPricing[] }>> {
  const result = await calculateRangePrice(propertyId, start, end);
  if (!result.success) return result;

  const bounded = result.data!.breakdown.map((day) => ({
    ...day,
    price: day.is_available
      ? Math.min(MAX_NIGHTLY_PRICE, Math.max(MIN_NIGHTLY_PRICE, day.price))
      : day.price,
  }));

  const total =
    Math.round(bounded.reduce((sum, d) => sum + (d.is_available ? d.price : 0), 0) * 100) / 100;

  return { success: true, data: { total, breakdown: bounded } };
}

/**
 * Return a full price quote for a stay: base rate breakdown, dynamic adjustments,
 * platform fee, and total. The total here is what booking creation will charge.
 */
export async function getPropertyQuote(
  propertyId: string,
  start: string,
  end: string,
  guestCount?: number,
): Promise<ServiceResponse<PriceQuote>> {
  // Validate dates
  const checkInDate = new Date(start);
  const checkOutDate = new Date(end);

  if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
    return { success: false, error: 'Invalid date format (use ISO 8601)' };
  }

  if (checkInDate >= checkOutDate) {
    return { success: false, error: 'Check-in date must be before check-out date' };
  }

  // Fetch property details
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('base_price_per_night, updated_at, status, draft_status, deleted_at, moderation_state, max_guests')
    .eq('id', propertyId)
    .single();

  if (propError || !property) {
    return { success: false, error: 'Property not found' };
  }

  // Quotes are public, so drafts, removed, and moderation-hidden listings are not quotable.
  const listing = property as {
    base_price_per_night: number;
    updated_at: string;
    status: string | null;
    draft_status: string | null;
    deleted_at: string | null;
    moderation_state: string | null;
    max_guests: number | null;
  };
  if (
    listing.deleted_at ||
    listing.status === 'draft' ||
    listing.draft_status === 'draft' ||
    listing.moderation_state === 'hidden'
  ) {
    return { success: false, error: 'Property not found' };
  }

  // Enforce occupancy limit at quote time so the token binds an eligible guest count.
  if (
    guestCount !== undefined &&
    listing.max_guests !== null &&
    listing.max_guests !== undefined &&
    guestCount > listing.max_guests
  ) {
    return {
      success: false,
      error: `Guest count (${guestCount}) exceeds property capacity (${listing.max_guests})`,
      statusCode: 400,
    };
  }

  const baseRate = listing.base_price_per_night;
  const propertyUpdatedAt = listing.updated_at;

  // Check for booked dates
  const { data: bookings } = await supabase
    .from('bookings')
    .select('check_in, check_out')
    .eq('property_id', propertyId)
    .neq('status', 'Cancelled')
    .lt('check_in', end)
    .gt('check_out', start);

  // Check for availability blocks
  const { data: blocks } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', end)
    .gt('end_date', start);

  // Build unavailable intervals list
  const unavailableIntervals: Array<{ start: string; end: string; reason: string }> = [];

  if (bookings && bookings.length > 0) {
    for (const booking of bookings as { check_in: string; check_out: string }[]) {
      unavailableIntervals.push({
        start: booking.check_in,
        end: booking.check_out,
        reason: 'Booking conflict',
      });
    }
  }

  if (blocks && blocks.length > 0) {
    for (const block of blocks as { start_date: string; end_date: string }[]) {
      unavailableIntervals.push({
        start: block.start_date,
        end: block.end_date,
        reason: 'Host blocked',
      });
    }
  }

  // Calculate pricing
  const rangeResult = await calculateRangePrice(propertyId, start, end);
  if (!rangeResult.success) return { success: false, error: rangeResult.error };

  const { breakdown } = rangeResult.data!;
  const nights = breakdown.filter((d) => d.is_available).length;
  const subtotal = Math.round(baseRate * nights * 100) / 100;
  const dynamicTotal = Math.round(rangeResult.data!.total * 100) / 100;
  const dynamicAdjustments = Math.round((dynamicTotal - subtotal) * 100) / 100;
  const platformFee = Math.round(dynamicTotal * PLATFORM_FEE_PCT * 100) / 100;
  const total = Math.round((dynamicTotal + platformFee) * 100) / 100;

  // Create quote version hash from property state
  const quoteVersion = Buffer.from(`${propertyId}:${propertyUpdatedAt}`).toString('base64');
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();

  // Bind the total to its exact inputs (including occupancy) so booking can verify nothing drifted.
  const quoteToken = signQuoteToken({
    pid: propertyId,
    ci:  checkInDate.toISOString(),
    co:  checkOutDate.toISOString(),
    tot: total,
    ver: propertyUpdatedAt,
    exp: expiresAt,
    ...(guestCount !== undefined ? { gc: guestCount } : {}),
  });

  return {
    success: true,
    data: {
      base_nightly_rate: baseRate,
      nights,
      subtotal,
      dynamic_adjustments: dynamicAdjustments,
      platform_fee_pct: PLATFORM_FEE_PCT,
      platform_fee: platformFee,
      total,
      breakdown,
      timezone: 'UTC',
      currency: 'USD',
      version: quoteVersion,
      expires_at: expiresAt,
      available: unavailableIntervals.length === 0,
      quote_token: quoteToken,
      unavailable_intervals: unavailableIntervals.length > 0 ? unavailableIntervals : undefined,
    },
  };
}

export interface QuotedTotalInput {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  /** Total the tenant submitted, in dollars. */
  clientTotal: number;
  /** Quote token from a previous getPropertyQuote call, if the client kept one. */
  quoteToken?: string;
  /** Clock override for tests. Defaults to now. */
  now?: number;
  /** Guest count the booking will use; checked against token gc when a token is supplied. */
  guestCount?: number;
}

/**
 * Confirm a tenant's submitted total against a fresh server-side quote before any
 * dates are reserved or money is authorised.
 *
 * The server total is authoritative. The client total must match it to the cent,
 * and a supplied quote token must still be valid, unexpired, and for the same
 * stay and listing version. Any mismatch fails rather than charging a different amount.
 *
 * @returns The authoritative total in dollars on success.
 */
export async function assertQuotedTotal(
  input: QuotedTotalInput,
): Promise<ServiceResponse<{ total: number; quote: PriceQuote }>> {
  const { propertyId, checkIn, checkOut, clientTotal, quoteToken } = input;
  const now = input.now ?? Date.now();

  const quoted = await getPropertyQuote(propertyId, checkIn, checkOut);
  if (!quoted.success || !quoted.data) {
    const notFound = quoted.error === 'Property not found';
    return {
      success: false,
      error: quoted.error ?? 'Could not price this stay',
      statusCode: notFound ? 404 : 400,
    };
  }

  const quote = quoted.data;

  if (!quote.available) {
    return {
      success: false,
      error: 'Property is not available for the requested dates',
      conflict: true,
      code: 'DATES_UNAVAILABLE',
      details: { unavailable_intervals: quote.unavailable_intervals ?? [] },
    };
  }

  if (quoteToken) {
    const claims = verifyQuoteToken(quoteToken);
    if (!claims) {
      return { success: false, error: 'Invalid quote token', statusCode: 400, code: 'QUOTE_INVALID' };
    }

    const normalisedIn = new Date(checkIn).toISOString();
    const normalisedOut = new Date(checkOut).toISOString();
    if (claims.pid !== propertyId || claims.ci !== normalisedIn || claims.co !== normalisedOut) {
      return {
        success: false,
        error: 'Quote does not match the requested stay',
        statusCode: 400,
        code: 'QUOTE_MISMATCH',
      };
    }

    if (Date.parse(claims.exp) <= now) {
      return {
        success: false,
        error: 'Quote has expired; request a new quote',
        conflict: true,
        code: 'QUOTE_EXPIRED',
        details: { quote },
      };
    }

    // The listing changed after this quote was issued.
    const issuedVersion = Buffer.from(`${propertyId}:${claims.ver}`).toString('base64');
    if (issuedVersion !== quote.version) {
      return {
        success: false,
        error: 'The listing changed after this quote was issued; request a new quote',
        conflict: true,
        code: 'PRICE_CHANGED',
        details: { quote },
      };
    }

    // Guest count must match what the token was issued for.
    if (
      input.guestCount !== undefined &&
      claims.gc !== undefined &&
      claims.gc !== input.guestCount
    ) {
      return {
        success: false,
        error: 'Quote was issued for a different guest count; request a new quote',
        statusCode: 400,
        code: 'QUOTE_MISMATCH',
      };
    }
  }

  if (Math.round(clientTotal * 100) !== Math.round(quote.total * 100)) {
    return {
      success: false,
      error: `The price for this stay is now $${quote.total.toFixed(2)}; it does not match the submitted total`,
      conflict: true,
      code: 'PRICE_CHANGED',
      details: { quote },
    };
  }

  return { success: true, data: { total: quote.total, quote } };
}
