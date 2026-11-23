import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import { toDay } from '@/utils/availabilityRange.js';
import { RESERVING_BOOKING_STATUSES } from '@/utils/bookingStatus.js';
import {
  type AppliedRule,
  MAX_PRICE_MULTIPLIER,
  MIN_PRICE_MULTIPLIER,
  findOverlappingRule,
  isNightlyPriceOutOfPolicy,
  isValidMultiplier,
  nightlyPriceCents,
  parseRuleDate,
  ruleForNight,
  toCents,
} from '@/utils/pricingRules.js';
import {
  type CurrencyCode,
  DEFAULT_CURRENCY,
  ROUNDING_MODE,
  currencyPrecision,
  fromMinorUnits,
  isSupportedCurrency,
  mulDivRoundHalfUp,
  toMinorUnits,
} from '@/utils/money.js';
import { signQuoteToken, verifyQuoteToken } from '@/utils/quoteToken.js';
import type { ServiceResponse } from './index.js';

/** Platform fee as an exact fraction (5/100) so the fee is computed in integer minor units. */
const PLATFORM_FEE_NUMERATOR = 5;
const PLATFORM_FEE_DENOMINATOR = 100;
/** Displayed as a percentage; the fee itself is always computed from the fraction above. */
const PLATFORM_FEE_PCT = PLATFORM_FEE_NUMERATOR / PLATFORM_FEE_DENOMINATOR;
/** How long a quote (and its token) stays valid before the client must re-quote. */
export const QUOTE_TTL_MS = 15 * 60 * 1000;
/** Version of the pricing rules and quote shape. Bump when the arithmetic changes. */
export const PRICING_VERSION = 'pv2';
/** Largest amount, in minor units, a single quote may total (guards against overflow). */
export const MAX_QUOTE_MINOR_UNITS = 1_000_000_000_000; // 10^12 minor units
=======

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
  /** Rules that set this night's price, in application order (seasonal, then event). */
  applied_rules?: AppliedRule[];
  /** True when the nightly price or a multiplier is outside policy. Such a quote is rejected. */
  out_of_policy?: boolean;
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
  /** Decimal places the currency uses; all amounts are exact at this precision. */
  currency_precision?: number;
  /** Rounding applied when a computed amount is not an exact multiple of the minor unit. */
  rounding_mode?: string;
  /** Total in integer minor units (e.g. cents). This is the amount the contract uses. */
  total_minor_units?: number;
  /** Where the currency conversion rate came from, when a conversion was applied. */
  rate_source?: string | null;
  /** ISO timestamp of when the conversion rate was captured. */
  rate_timestamp?: string | null;
  /** Original amount in the requested (display) currency, before conversion. */
  original_currency?: string;
  original_amount?: number;
  version?: string;
  expires_at?: string;
  /** True when every requested night is bookable. */
  available: boolean;
  /** Signed binding of this total to its inputs; null when signing is not configured. */
  quote_token: string | null;
  /** Pricing rule version this quote was computed under (see PRICING_VERSION). */
  pricing_version?: string;
  /**
   * Fingerprint of the nightly prices, availability and applied rules. It changes when
   * any rule that affects this stay changes, even if the listing's updated_at does not.
   */
  pricing_fingerprint?: string;
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

  // Reject base prices that cannot be represented exactly at the currency's precision.
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    return { success: false, error: 'Property base price is invalid' };
  }
  if (toMinorUnits(basePrice, DEFAULT_CURRENCY) === null) {
    return { success: false, error: 'Property base price exceeds supported precision' };
  }

  // Rules that can touch this range. Precedence is applied per night by ruleForNight.
  const { data: seasonalRates } = await supabase
    .from('seasonal_pricing')
    .select('*')
    .eq('property_id', propertyId)
    .lte('start_date', checkOut)
    .gte('end_date', checkIn);

  const { data: events } = await supabase
    .from('special_events')
    .select('*')
    .eq('property_id', propertyId)
    .lte('start_date', checkOut)
    .gte('end_date', checkIn);

  // Reserving bookings that overlap the range (same status set as the booking RPC).
  const { data: bookings } = await supabase
    .from('bookings')
    .select('check_in, check_out')
    .eq('property_id', propertyId)
    .in('status', [...RESERVING_BOOKING_STATUSES])
    .lt('check_in', checkOut)
    .gt('check_out', checkIn);

  // Host availability blocks.
  const { data: blocks } = await supabase
    .from('availability_ranges')
    .select('start_date, end_date')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOut)
    .gt('end_date', checkIn);

  const blockedEvents = (events ?? []).filter((e) => e.is_blocked);
  const pricedEvents = (events ?? []).filter(
    (e) => !e.is_blocked && e.price_multiplier !== null && e.price_multiplier !== undefined,
  ) as Array<SpecialEvent & { price_multiplier: number }>;
  const seasonal = (seasonalRates ?? []) as SeasonalPricing[];

  const breakdown: DayPricing[] = [];
  let totalCents = 0;

  // Iterate UTC calendar days so a local timezone or DST change cannot skip or repeat a night.
  const lastNightExclusive = new Date(toDay(checkOutDate));
  for (
    let d = new Date(toDay(checkInDate));
    d < lastNightExclusive;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const dateStr = d.toISOString().split('T')[0];

    const blockedEvent = blockedEvents.find((e) => dateStr >= e.start_date && dateStr < e.end_date);
    if (blockedEvent) {
      breakdown.push({
        date: dateStr,
        price: 0,
        is_available: false,
        reason: `Blocked: ${blockedEvent.name}`,
      });
      continue;
    }

    if (bookings?.some((b) => dateStr >= b.check_in && dateStr < b.check_out)) {
      breakdown.push({ date: dateStr, price: 0, is_available: false, reason: 'Already booked' });
      continue;
    }

    if (blocks?.some((b) => dateStr >= b.start_date && dateStr < b.end_date)) {
      breakdown.push({ date: dateStr, price: 0, is_available: false, reason: 'Host blocked' });
      continue;
    }

    const appliedRules: AppliedRule[] = [];
    const seasonalRate = ruleForNight(seasonal, dateStr);
    if (seasonalRate) {
      appliedRules.push({
        kind: 'seasonal',
        id: seasonalRate.id,
        name: seasonalRate.name,
        multiplier: seasonalRate.price_multiplier,
      });
    }
    const event = ruleForNight(pricedEvents, dateStr);
    if (event) {
      appliedRules.push({
        kind: 'event',
        id: event.id,
        name: event.name,
        multiplier: event.price_multiplier,
      });
    }

    const priceCents = nightlyPriceCents(
      basePrice,
      appliedRules.map((r) => r.multiplier),
    );
    const outOfPolicy =
      isNightlyPriceOutOfPolicy(priceCents) ||
      appliedRules.some((r) => !isValidMultiplier(r.multiplier));

    // Out-of-policy nights keep their computed price in the breakdown so the host can
    // see the problem. The quote is rejected, so the price is never charged.
    const dayPriceCents = priceCents ?? 0;
    totalCents += dayPriceCents;

    breakdown.push({
      date: dateStr,
      price: fromMinorUnits(dayPriceCents, DEFAULT_CURRENCY),
      is_available: true,
      applied_rules: appliedRules,
      out_of_policy: outOfPolicy,
    });
  }

  const total = fromMinorUnits(totalCents, DEFAULT_CURRENCY);
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

/** Validate a rule's dates and multiplier. Returns a refusal, or null when valid. */
function validateRuleInput(
  startDate: string,
  endDate: string,
  multiplier: number,
): ServiceResponse<never> | null {
  if (!isValidMultiplier(multiplier)) {
    return {
      success: false,
      error: `price_multiplier must be a finite number between ${MIN_PRICE_MULTIPLIER} and ${MAX_PRICE_MULTIPLIER}`,
      statusCode: 400,
      code: 'INVALID_MULTIPLIER',
    };
  }
  const start = parseRuleDate(startDate);
  const end = parseRuleDate(endDate);
  if (start === null || end === null) {
    return {
      success: false,
      error: 'start_date and end_date must be valid dates',
      statusCode: 400,
    };
  }
  if (start >= end) {
    return { success: false, error: 'start_date must be before end_date', statusCode: 400 };
  }
  return null;
}

/** The refusal for a rule that overlaps an existing one. Names the rule that clashes. */
function overlapRefusal(clash: {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
}): ServiceResponse<never> {
  return {
    success: false,
    error: `Overlaps the existing rule "${clash.name}" (${clash.start_date} to ${clash.end_date}). Edit or delete that rule first.`,
    statusCode: 409,
    conflict: true,
    code: 'RULE_OVERLAP',
    details: { rule_id: clash.id },
  };
}

/**
 * Create seasonal pricing rule
 */
export async function createSeasonalPricing(
  propertyId: string,
  ownerId: string,
  input: Omit<SeasonalPricing, 'id' | 'property_id' | 'created_at'>,
): Promise<ServiceResponse<SeasonalPricing>> {
  const ruleCheck = validateRuleInput(input.start_date, input.end_date, input.price_multiplier);
  if (ruleCheck) return ruleCheck;

  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  // Seasonal rules may not overlap: each night has exactly one seasonal multiplier.
  const { data: existingSeasonal, error: existingError } = await supabase
    .from('seasonal_pricing')
    .select('id, name, start_date, end_date')
    .eq('property_id', propertyId);
  if (existingError) return { success: false, error: existingError.message };

  const clashSeasonal = findOverlappingRule(input, (existingSeasonal ?? []) as SeasonalPricing[]);
  if (clashSeasonal) return overlapRefusal(clashSeasonal);

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
  const pricesThisEvent = !input.is_blocked && input.price_multiplier !== undefined;
  const ruleCheck = validateRuleInput(
    input.start_date,
    input.end_date,
    pricesThisEvent ? input.price_multiplier : 1,
  );
  if (ruleCheck) return ruleCheck;

  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden' };
  }

  // Priced events may not overlap each other. Blocked events may overlap anything,
  // because a block always wins over a price.
  if (pricesThisEvent) {
    const { data: existingEvents, error: existingError } = await supabase
      .from('special_events')
      .select('id, name, start_date, end_date, is_blocked, price_multiplier')
      .eq('property_id', propertyId)
      .eq('is_blocked', false);
    if (existingError) return { success: false, error: existingError.message };

    const pricedExisting = ((existingEvents ?? []) as SpecialEvent[]).filter(
      (e) => e.price_multiplier !== null && e.price_multiplier !== undefined,
    );
    const clashEvent = findOverlappingRule(input, pricedExisting);
    if (clashEvent) return overlapRefusal(clashEvent);
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
 * Per-day effective prices for a date range, for hosts checking their rules before
 * publishing. Out-of-policy nights are flagged (`out_of_policy`) and left at the
 * computed price. They are not clamped into range, because a clamped preview would
 * show a rate that no quote will ever charge.
 */
export async function previewPricing(
  propertyId: string,
  start: string,
  end: string,
): Promise<ServiceResponse<{ total: number; breakdown: DayPricing[] }>> {
  const result = await calculateRangePrice(propertyId, start, end);
  if (!result.success) return result;
  return { success: true, data: result.data! };
}

/** Next calendar day (YYYY-MM-DD) after a YYYY-MM-DD date, in UTC. */
function nextDay(date: string): string {
  return new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Group unavailable nights into contiguous half-open intervals with a reason.
 * Reasons use the public vocabulary: "Booking conflict", "Host blocked", or
 * "Blocked: <event>" for a blocked special event.
 */
export function unavailableRuns(
  breakdown: DayPricing[],
): Array<{ start: string; end: string; reason: string }> {
  const runs: Array<{ start: string; end: string; reason: string }> = [];
  for (const day of breakdown) {
    if (day.is_available) continue;
    const reason =
      day.reason === 'Already booked' ? 'Booking conflict' : (day.reason ?? 'Unavailable');
    const last = runs[runs.length - 1];
    if (last && last.reason === reason && last.end === day.date) {
      last.end = nextDay(day.date);
    } else {
      runs.push({ start: day.date, end: nextDay(day.date), reason });
    }
  }
  return runs;
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
  currency: string = DEFAULT_CURRENCY,
): Promise<ServiceResponse<PriceQuote>> {
  // Validate the requested currency before doing any work.
  if (!isSupportedCurrency(currency)) {
    return {
      success: false,
      error: `Unsupported currency: ${currency}`,
      statusCode: 400,
      code: 'UNSUPPORTED_CURRENCY',
    };
  }
  const quoteCurrency = currency as CurrencyCode;
  const precision = currencyPrecision(quoteCurrency);

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
    .select(
      'base_price_per_night, updated_at, status, draft_status, deleted_at, moderation_state, max_guests',
    )
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

  // Guard against zero, negative, non-finite, or over-precise base rates.
  if (!Number.isFinite(baseRate) || baseRate <= 0) {
    return {
      success: false,
      error: 'Property base price is invalid',
      statusCode: 422,
      code: 'INVALID_BASE_PRICE',
    };
  }
  const baseRateMinor = toMinorUnits(baseRate, quoteCurrency);
  if (baseRateMinor === null) {
    return {
      success: false,
      error: `Property base price exceeds the ${precision} decimal places supported for ${quoteCurrency}`,
      statusCode: 422,
      code: 'PRICE_PRECISION_EXCEEDED',
    };
  }

  // Price the stay first. The day-by-day breakdown is the single source of truth
  // for availability: a night is unavailable if it is booked, host-blocked or
  // blocked by a special event. Deriving the quote from it keeps the displayed
  // availability, the checkout and the stored total on one definition.
  const rangeResult = await calculateRangePrice(propertyId, start, end);
  if (!rangeResult.success) return { success: false, error: rangeResult.error };

  const { breakdown } = rangeResult.data!;

  // A stay with an out-of-policy night cannot be quoted at all. The host has to fix the rule.
  const violations = breakdown.filter((d) => d.is_available && d.out_of_policy);
  if (violations.length > 0) {
    return {
      success: false,
      error: 'The nightly price for these dates is outside the allowed range',
      statusCode: 422,
      code: 'PRICE_OUT_OF_POLICY',
      details: {
        nights: violations.map((d) => ({
          date: d.date,
          price: d.price,
          rules: (d.applied_rules ?? []).map((r) => ({ kind: r.kind, id: r.id, name: r.name })),
        })),
      },
    };
  }

  const unavailableIntervals = unavailableRuns(breakdown);
  const availableNights = breakdown.filter((d) => d.is_available);
  const nights = availableNights.length;

  // Money is summed in whole minor units. Each night is already rounded to the
  // currency's precision, so the total is exact and independent of summation order.
  let dynamicMinor = 0;
  for (const d of availableNights) {
    const nightMinor = toMinorUnits(d.price, quoteCurrency);
    if (nightMinor === null) {
      return {
        success: false,
        error: `Nightly price for ${d.date} exceeds the precision supported for ${quoteCurrency}`,
        statusCode: 422,
        code: 'PRICE_PRECISION_EXCEEDED',
        details: { date: d.date, price: d.price },
      };
    }
    dynamicMinor += nightMinor;
  }
  const baseMinor = baseRateMinor * nights;
  // Fee is an exact integer computation: round(dynamic * 5 / 100) half-up.
  const feeMinor = mulDivRoundHalfUp(dynamicMinor, PLATFORM_FEE_NUMERATOR, PLATFORM_FEE_DENOMINATOR);
  const totalMinor = dynamicMinor + feeMinor;

  if (!Number.isSafeInteger(totalMinor) || totalMinor > MAX_QUOTE_MINOR_UNITS) {
    return {
      success: false,
      error: 'The total for this stay exceeds the maximum supported amount',
      statusCode: 422,
      code: 'AMOUNT_TOO_LARGE',
    };
  }

  const subtotal = fromMinorUnits(baseMinor, quoteCurrency);
  const dynamicTotal = fromMinorUnits(dynamicMinor, quoteCurrency);
  const dynamicAdjustments = fromMinorUnits(dynamicMinor - baseMinor, quoteCurrency);
  const platformFee = fromMinorUnits(feeMinor, quoteCurrency);
  const total = fromMinorUnits(totalMinor, quoteCurrency);

  // Fingerprint of the nights this stay depends on. A rule change that touches these
  // nights changes it, even when the listing's updated_at has not moved.
  const pricingFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        base: baseRate,
        nights: breakdown.map((d) => [
          d.date,
          d.is_available,
          d.price,
          (d.applied_rules ?? []).map((r) => [r.kind, r.id, r.multiplier]),
        ]),
      }),
    )
    .digest('hex')
    .slice(0, 32);

  // Create quote version hash from property state
  const quoteVersion = Buffer.from(`${propertyId}:${propertyUpdatedAt}`).toString('base64');
  const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();

  // Bind the total to its exact inputs (including occupancy) so booking can verify nothing drifted.
  const quoteToken = signQuoteToken({
    pid: propertyId,
    ci: checkInDate.toISOString(),
    co: checkOutDate.toISOString(),
    tot: total,
    ver: propertyUpdatedAt,
    qv: pricingFingerprint,
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
      currency: quoteCurrency,
      currency_precision: precision,
      rounding_mode: ROUNDING_MODE,
      total_minor_units: totalMinor,
      // No conversion is applied here: the quote is denominated directly in the
      // requested currency. Rate metadata is present so support and the UI can
      // disclose the (absent) conversion and its age.
      rate_source: null,
      rate_timestamp: null,
      original_currency: quoteCurrency,
      original_amount: total,
      version: quoteVersion,
      expires_at: expiresAt,
      available: unavailableIntervals.length === 0,
      quote_token: quoteToken,
      pricing_version: PRICING_VERSION,
      pricing_fingerprint: pricingFingerprint,
      unavailable_intervals: unavailableIntervals.length > 0 ? unavailableIntervals : undefined,
    },
  };
}

/**
 * The part of an accepted quote that a booking keeps: the nightly line items with the
 * rules that set each price, and the totals. Written once, at booking creation, so a
 * host can later explain exactly what the tenant agreed to.
 */
export function pricingSnapshotFromQuote(quote: PriceQuote): Record<string, unknown> {
  return {
    version: quote.pricing_version ?? null,
    fingerprint: quote.pricing_fingerprint ?? null,
    currency: quote.currency ?? DEFAULT_CURRENCY,
    currency_precision: quote.currency_precision ?? currencyPrecision(DEFAULT_CURRENCY),
    rounding_mode: quote.rounding_mode ?? ROUNDING_MODE,
    total_minor_units: quote.total_minor_units ?? null,
    rate_source: quote.rate_source ?? null,
    rate_timestamp: quote.rate_timestamp ?? null,
    original_currency: quote.original_currency ?? quote.currency ?? DEFAULT_CURRENCY,
    original_amount: quote.original_amount ?? quote.total,
    base_nightly_rate: quote.base_nightly_rate,
    nights: quote.nights,
    subtotal: quote.subtotal,
    dynamic_adjustments: quote.dynamic_adjustments,
    platform_fee_pct: quote.platform_fee_pct,
    platform_fee: quote.platform_fee,
    total: quote.total,
    nightly: quote.breakdown
      .filter((d) => d.is_available)
      .map((d) => ({ date: d.date, price: d.price, applied_rules: d.applied_rules ?? [] })),
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
      return {
        success: false,
        error: 'Invalid quote token',
        statusCode: 400,
        code: 'QUOTE_INVALID',
      };
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

    // The nightly prices or applied rules for this stay changed after the quote was issued.
    if (claims.qv !== undefined && claims.qv !== quote.pricing_fingerprint) {
      return {
        success: false,
        error: 'The pricing for this stay changed after this quote was issued; request a new quote',
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

  // Compare in integer minor units so no binary floating-point rounding can slip through.
  const quoteCurrency = (quote.currency ?? DEFAULT_CURRENCY) as CurrencyCode;
  const clientMinor = toMinorUnits(clientTotal, quoteCurrency);
  if (clientMinor === null) {
    return {
      success: false,
      error: `The submitted total is not a valid ${quoteCurrency} amount at supported precision`,
      statusCode: 400,
      code: 'INVALID_AMOUNT',
    };
  }
  const quoteMinor = quote.total_minor_units ?? toMinorUnits(quote.total, quoteCurrency);
  if (quoteMinor === null || clientMinor !== quoteMinor) {
    return {
      success: false,
      error: `The price for this stay is now ${quote.total.toFixed(currencyPrecision(quoteCurrency))} ${quoteCurrency}; it does not match the submitted total`,
      conflict: true,
      code: 'PRICE_CHANGED',
      details: { quote },
    };
  }

  return { success: true, data: { total: quote.total, quote } };
}
