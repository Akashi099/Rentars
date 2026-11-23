/**
 * Exchange Rate Service
 *
 * Fetches USDC→local-currency conversion rates from a public free API
 * (exchangerate-api.com free tier / open.er-api.com) and caches the result
 * in Redis with a configurable TTL.
 *
 * Architecture decisions:
 *  - Rates are informational only — charges always happen in USDC.
 *  - A background refresh loop keeps the in-process fallback cache warm so
 *    the endpoint never blocks on a cold cache during peak traffic.
 *  - The rate source is configurable via EXCHANGE_RATE_API_URL so teams can
 *    swap providers without code changes.
 *  - On fetch failure the last known rates are returned (stale-while-revalidate
 *    semantics) so the UI degrades gracefully rather than breaking.
 */

import * as cache from './cache.service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Currencies we commit to displaying.  Extend as needed. */
export const SUPPORTED_DISPLAY_CURRENCIES = [
  'USD', // baseline — 1:1 with USDC by definition
  'EUR',
  'GBP',
  'JPY',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'BRL',
  'INR',
  'MXN',
  'NGN',
  'KES',
  'ZAR',
  'SGD',
  'HKD',
  'NOK',
  'SEK',
  'DKK',
  'PLN',
] as const;

export type DisplayCurrency = (typeof SUPPORTED_DISPLAY_CURRENCIES)[number];

/**
 * Canonical decimal precision (number of fractional digits) per display
 * currency, following ISO 4217 minor-unit conventions.  All conversions and
 * rounding decisions must use these values so the UI, API, database and
 * contract agree on the amount.
 */
export const CURRENCY_DECIMALS: Record<DisplayCurrency, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0, // no minor unit
  CAD: 2,
  AUD: 2,
  CHF: 2,
  CNY: 2,
  BRL: 2,
  INR: 2,
  MXN: 2,
  NGN: 2,
  KES: 2,
  ZAR: 2,
  SGD: 2,
  HKD: 2,
  NOK: 2,
  SEK: 2,
  DKK: 2,
  PLN: 2,
};

/**
 * USDC has 6 decimal places on-chain (1 USDC = 1_000_000 base units).
 * This is the canonical precision for all payment amounts.
 */
export const USDC_DECIMALS = 6;

/** Number of minor units in one USDC (10^6). */
export const USDC_MINOR_UNITS_PER_UNIT = 10 ** USDC_DECIMALS;

/**
 * Rounding mode applied when converting USDC → display currency.
 * Documented here so quotes can disclose their rounding behaviour.
 */
export const CONVERSION_ROUNDING_MODE = 'HALF_UP' as const;
export type ConversionRoundingMode = typeof CONVERSION_ROUNDING_MODE;

export interface ExchangeRates {
  /** Base currency — always USDC (pegged 1:1 to USD). */
  base: 'USDC';
  /** ISO 4217 code → units of that currency per 1 USDC */
  rates: Record<DisplayCurrency, number>;
  /** Unix timestamp (ms) when rates were last fetched from upstream. */
  fetched_at: number;
  /** Unix timestamp (ms) after which the consumer should treat rates as stale. */
  expires_at: number;
  /** Identifier of the upstream provider the rates came from. */
  source: string;
  /** Rounding mode used when converting USDC to a display currency. */
  rounding: ConversionRoundingMode;
}

/** Conversion details attached to a quote for support & user disclosure. */
export interface ConversionDetails {
  /** Original amount in USDC (decimal string, exact). */
  original_amount_usdc: string;
  /** Converted amount in the target currency (decimal string, exact). */
  converted_amount: string;
  /** Target display currency. */
  currency: DisplayCurrency;
  /** Rate applied (units of currency per 1 USDC). */
  rate: number;
  /** Rate source identifier. */
  rate_source: string;
  /** Unix timestamp (ms) when the rate was fetched. */
  rate_fetched_at: number;
  /** Age of the rate in seconds at conversion time. */
  rate_age_seconds: number;
  /** True when the rate is older than its expiry. */
  stale: boolean;
  /** Rounding mode applied. */
  rounding: ConversionRoundingMode;
  /** Decimal precision of the target currency. */
  decimals: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * How long (seconds) to keep rates in Redis.
 * Overrideable via EXCHANGE_RATE_CACHE_TTL env var.
 */
const CACHE_TTL_SECONDS = Number(process.env.EXCHANGE_RATE_CACHE_TTL ?? 300); // 5 min default

/** Redis key for the cached rates object. */
const CACHE_KEY = 'exchange_rates:usdc';

/**
 * Upstream exchange-rate API endpoint.
 * Default: open.er-api.com free tier (no key required, 1,500 req/month on free plan).
 * Override via EXCHANGE_RATE_API_URL.
 */
const API_URL =
  process.env.EXCHANGE_RATE_API_URL ?? 'https://open.er-api.com/v6/latest/USD';

// ─── In-process fallback ──────────────────────────────────────────────────────

/** Last successfully fetched rates held in memory as a safety net. */
let inProcessCache: ExchangeRates | null = null;

// ─── Fetch & transform ────────────────────────────────────────────────────────

interface ErApiResponse {
  result: string;
  base_code: string;
  rates: Record<string, number>;
  time_last_update_unix?: number;
}

/**
 * Fetch fresh rates from upstream, filter to supported currencies, and wrap in
 * the ExchangeRates envelope.  Throws on network/parse error.
 */
async function fetchFreshRates(): Promise<ExchangeRates> {
  const res = await fetch(API_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Exchange-rate API responded with ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as ErApiResponse;

  if (body.result && body.result !== 'success') {
    throw new Error(`Exchange-rate API error: ${body.result}`);
  }

  const now = Date.now();

  // Build filtered rates — always include USD=1.0 as the USDC anchor.
  const rates = {} as Record<DisplayCurrency, number>;
  for (const code of SUPPORTED_DISPLAY_CURRENCIES) {
    rates[code] = code === 'USD' ? 1.0 : (body.rates[code] ?? 0);
  }

  return {
    base: 'USDC',
    rates,
    fetched_at: now,
    expires_at: now + CACHE_TTL_SECONDS * 1_000,
    source: API_URL,
    rounding: CONVERSION_ROUNDING_MODE,
  };
}

// ─── Decimal-safe helpers ─────────────────────────────────────────────────────

/**
 * Convert a USDC amount (decimal number or string) to integer minor units
 * (6 decimals).  Rejects values with more precision than USDC supports, as
 * well as non-finite, zero or negative amounts.
 *
 * Uses string parsing to avoid binary floating-point rounding.
 *
 * @throws Error when the amount is invalid or exceeds USDC precision.
 */
export function usdcToMinorUnits(amount: number | string): bigint {
  const str = typeof amount === 'number' ? numberToPlainString(amount) : amount.trim();
  return decimalStringToMinorUnits(str, USDC_DECIMALS, 'USDC amount');
}

/**
 * Convert integer USDC minor units back to a decimal string with exactly
 * USDC precision (e.g. 1_500_000n → "1.500000").
 */
export function minorUnitsToUsdc(minorUnits: bigint): string {
  return minorUnitsToDecimalString(minorUnits, USDC_DECIMALS);
}

/**
 * Convert a decimal amount in the given currency to integer minor units,
 * validating against that currency's canonical precision.
 *
 * @throws Error when the currency is unsupported or the amount exceeds precision.
 */
export function currencyToMinorUnits(
  amount: number | string,
  currency: DisplayCurrency,
): bigint {
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  const str = typeof amount === 'number' ? numberToPlainString(amount) : amount.trim();
  return decimalStringToMinorUnits(str, decimals, `${currency} amount`);
}

/**
 * Convert integer minor units in the given currency back to a decimal string.
 */
export function minorUnitsToCurrency(
  minorUnits: bigint,
  currency: DisplayCurrency,
): string {
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) {
    throw new Error(`Unsupported currency: ${currency}`);
  }
  return minorUnitsToDecimalString(minorUnits, decimals);
}

/**
 * Render a JS number as a plain decimal string without exponent notation.
 * Used to feed numbers into the string-based decimal helpers safely.
 */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  const str = String(value);
  if (!str.includes('e') && !str.includes('E')) return str;
  // Expand exponent notation (e.g. 1e-7) into plain decimal form.
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Parse a plain decimal string into integer minor units with the given
 * precision.  Rejects zero/negative values and any fractional digits beyond
 * the supported precision.
 */
function decimalStringToMinorUnits(
  input: string,
  decimals: number,
  label: string,
): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(input);
  if (!match) {
    throw new Error(`Invalid ${label}: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (sign === '-') {
    throw new Error(`${label} must be positive: "${input}"`);
  }
  if (fraction.length > decimals) {
    throw new Error(
      `${label} exceeds supported precision of ${decimals} decimals: "${input}"`,
    );
  }
  const paddedFraction = fraction.padEnd(decimals, '0');
  const minor = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || '0');
  if (minor <= 0n) {
    throw new Error(`${label} must be greater than zero: "${input}"`);
  }
  return minor;
}

/**
 * Render integer minor units as a decimal string with the given precision.
 */
function minorUnitsToDecimalString(minorUnits: bigint, decimals: number): string {
  if (minorUnits < 0n) {
    throw new Error(`Minor units must be non-negative: ${minorUnits}`);
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = minorUnits / divisor;
  const fraction = minorUnits % divisor;
  if (decimals === 0) return whole.toString();
  return `${whole.toString()}.${fraction.toString().padStart(decimals, '0')}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return current USDC exchange rates.
 *
 * Resolution order:
 *   1. Redis cache (warm, fast)
 *   2. Upstream API (cold fetch, updates Redis + in-process cache)
 *   3. In-process stale cache (API unavailable fallback)
 *
 * Never throws — returns the best available data plus a `stale` flag so the
 * consumer can decide whether to surface a UI warning.
 */
export async function getExchangeRates(): Promise<ExchangeRates & { stale?: boolean }> {
  // 1. Try Redis
  try {
    const cached = await cache.get<ExchangeRates>(CACHE_KEY);
    if (cached) {
      return cached;
    }
  } catch {
    // Redis unavailable — fall through
  }

  // 2. Try upstream
  try {
    const fresh = await fetchFreshRates();
    // Persist to Redis and in-process cache
    await cache.set(CACHE_KEY, fresh, CACHE_TTL_SECONDS).catch(() => {});
    inProcessCache = fresh;
    return fresh;
  } catch (err) {
    console.warn('[ExchangeRateService] Upstream fetch failed:', err);
  }

  // 3. Stale in-process fallback
  if (inProcessCache) {
    console.warn('[ExchangeRateService] Returning stale in-process rates');
    return { ...inProcessCache, stale: true };
  }

  // 4. Last resort — return 1:1 rates so the UI shows USDC = USD
  const now = Date.now();
  const fallback: ExchangeRates & { stale: boolean } = {
    base: 'USDC',
    rates: Object.fromEntries(
      SUPPORTED_DISPLAY_CURRENCIES.map((c) => [c, c === 'USD' ? 1 : 0]),
    ) as Record<DisplayCurrency, number>,
    fetched_at: now,
    expires_at: now,
    source: 'fallback',
    rounding: CONVERSION_ROUNDING_MODE,
    stale: true,
  };
  return fallback;
}

/**
 * Determine whether the given rates should be treated as stale, based on the
 * expiry timestamp and/or an explicit stale flag.
 */
export function isRateStale(rates: ExchangeRates & { stale?: boolean }): boolean {
  if (rates.stale) return true;
  return Date.now() > rates.expires_at;
}

/**
 * Age of the rates in seconds at the current time (never negative).
 */
export function rateAgeSeconds(rates: ExchangeRates): number {
  return Math.max(0, Math.floor((Date.now() - rates.fetched_at) / 1_000));
}

/**
 * Force-refresh the exchange rates from upstream and repopulate the caches.
 * Called by the background refresh task; also useful in tests.
 */
export async function refreshExchangeRates(): Promise<ExchangeRates> {
  const fresh = await fetchFreshRates();
  await cache.set(CACHE_KEY, fresh, CACHE_TTL_SECONDS).catch(() => {});
  inProcessCache = fresh;
  return fresh;
}

/**
 * Convert a USDC amount to the target display currency using current rates.
 *
 * Returns null when the target currency is unsupported or the rate is zero
 * (indicates the rate was unavailable at fetch time).
 *
 * The conversion is decimal-safe: the USDC amount is first converted to exact
 * integer minor units, then multiplied by the rate and rounded HALF_UP to the
 * target currency's canonical precision.  No binary floating-point rounding
 * can change the resulting amount.
 *
 * @param amountUsdc - Amount in USDC to convert (number or decimal string).
 * @param targetCurrency - ISO 4217 code of the display currency.
 * @param rates - Pre-fetched rates object (avoids a redundant cache hit per call).
 */
export function convertUsdc(
  amountUsdc: number | string,
  targetCurrency: string,
  rates: ExchangeRates,
): number | null {
  const details = convertUsdcWithDetails(amountUsdc, targetCurrency, rates);
  return details === null ? null : Number(details.converted_amount);
}

/**
 * Like {@link convertUsdc} but returns full conversion details (original
 * amount, converted amount, rate source, timestamp, age, rounding) suitable
 * for storing on a quote and disclosing to the user.
 *
 * Returns null when the target currency is unsupported or the rate is zero.
 * Throws when the USDC amount exceeds supported precision or is not positive.
 */
export function convertUsdcWithDetails(
  amountUsdc: number | string,
  targetCurrency: string,
  rates: ExchangeRates & { stale?: boolean },
): ConversionDetails | null {
  const currency = targetCurrency as DisplayCurrency;
  const decimals = CURRENCY_DECIMALS[currency];
  if (decimals === undefined) return null;

  const rate = rates.rates[currency];
  if (!rate || rate === 0) return null;

  // Exact USDC amount in minor units (validates precision & positivity).
  const usdcMinor = usdcToMinorUnits(amountUsdc);

  // Scale the rate to an integer with 12 decimals of precision so the
  // multiplication stays in integer arithmetic.
  const RATE_SCALE = 12;
  const rateScaled = decimalStringToMinorUnits(
    numberToPlainString(rate),
    RATE_SCALE,
    'exchange rate',
  );

  // convertedMinor = usdcMinor * rateScaled / 10^USDC_DECIMALS, expressed in
  // units of 10^-RATE_SCALE of the target currency.  Then round HALF_UP to the
  // target currency's precision.
  const scaledProduct = usdcMinor * rateScaled; // units: 10^-(USDC_DECIMALS + RATE_SCALE)
  const targetDivisor = 10n ** BigInt(USDC_DECIMALS + RATE_SCALE - decimals);
  const convertedMinor = (scaledProduct + targetDivisor / 2n) / targetDivisor; // HALF_UP

  const convertedAmount = minorUnitsToDecimalString(convertedMinor, decimals);

  return {
    original_amount_usdc: minorUnitsToUsdc(usdcMinor),
    converted_amount: convertedAmount,
    currency,
    rate,
    rate_source: rates.source,
    rate_fetched_at: rates.fetched_at,
    rate_age_seconds: rateAgeSeconds(rates),
    stale: isRateStale(rates),
    rounding: CONVERSION_ROUNDING_MODE,
    decimals,
  };
}

// ─── Background refresh ───────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background interval that pre-warms the Redis cache before it expires.
 * Call once at server startup.  Safe to call multiple times — only one interval
 * is created.
 *
 * @param intervalMs - Refresh cadence in milliseconds (default: 4 minutes, just
 *   before the 5-minute Redis TTL so there is always a warm cache entry).
 */
export function startRateRefreshLoop(intervalMs = 4 * 60 * 1_000): void {
  if (refreshTimer !== null) return;

  // Seed the cache immediately on startup
  refreshExchangeRates().catch((err) =>
    console.warn('[ExchangeRateService] Initial seed failed:', err),
  );

  refreshTimer = setInterval(() => {
    refreshExchangeRates().catch((err) =>
      console.warn('[ExchangeRateService] Background refresh failed:', err),
    );
  }, intervalMs);

  // Allow the process to exit cleanly even if the timer is still alive
  if (refreshTimer.unref) refreshTimer.unref();
}
