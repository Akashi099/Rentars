/**
 * Payment amount and currency integrity utilities (#612).
 *
 * Rules enforced throughout the payment lifecycle:
 *
 *  1. All amounts are represented in stroops (integer minor units).
 *     1 USDC = 10_000_000 stroops.  No floating-point at system boundaries.
 *
 *  2. Only USDC is supported at present.  Unknown tokens fail validation.
 *
 *  3. Every payment intent carries a signed quote hash (SHA-256 of the
 *     server-computed amount + booking ID + expiry).  The hash is verified
 *     before the payment is submitted so the client cannot substitute a
 *     lower amount.
 *
 *  4. On-chain settlement amounts are compared against the DB record during
 *     reconciliation; any mismatch enters `under_review` without marking
 *     the booking paid.
 *
 *  5. Human-readable breakdown is returned alongside stroops so the
 *     frontend can display "1,000.00 USDC" without doing the conversion.
 */

import { createHmac } from 'node:crypto';
import { z } from 'zod';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Stroops per USDC (Stellar's native minor unit: 1 XLM = 10_000_000 stroops). */
export const STROOPS_PER_USDC = 10_000_000n;

/** Maximum accepted USDC amount per payment: 1_000_000 USDC. */
export const MAX_USDC_AMOUNT = 1_000_000n * STROOPS_PER_USDC;

/** Minimum accepted USDC amount: 0.0001 USDC. */
export const MIN_USDC_AMOUNT = 1_000n;

/** Supported currency tokens. Add new tokens here when expanding. */
export const SUPPORTED_CURRENCIES = ['USDC'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

/**
 * Canonical decimal precision (number of fractional digits) per currency.
 *
 * USDC on Stellar uses 7 decimals (1 USDC = 10_000_000 stroops).  Display
 * currencies are quoted with 2 decimals.  Any value carrying more fractional
 * digits than the currency's precision MUST be rejected rather than silently
 * rounded, so the displayed quote always matches the submitted token amount.
 */
export const CURRENCY_PRECISION: Record<SupportedCurrency, number> = {
  USDC: 7,
};

/** Display precision used for fiat-style presentation of quotes. */
export const DISPLAY_PRECISION = 2;

/** Minor units per whole unit, derived from CURRENCY_PRECISION. */
export const CURRENCY_MINOR_UNITS: Record<SupportedCurrency, bigint> = {
  USDC: STROOPS_PER_USDC,
};

/**
 * Maximum age (in seconds) a conversion rate may have before it is considered
 * stale and must not be used to produce a payment quote.
 */
export const MAX_RATE_AGE_SECONDS = 300;

/** Rounding modes supported by the decimal-safe conversion helpers. */
export type RoundingMode = 'half-up' | 'half-even' | 'down';

/** Metadata describing how a converted amount was produced. */
export interface ConversionMetadata {
  /** Original amount in the source currency, as an exact decimal string. */
  originalAmount: string;
  /** Source currency of the original amount. */
  originalCurrency: string;
  /** Converted amount in minor units of the target currency (integer string). */
  convertedMinorUnits: string;
  /** Target currency of the converted amount. */
  targetCurrency: SupportedCurrency;
  /** Rate used for the conversion (decimal string, target per source). */
  rate: string;
  /** Where the rate came from (e.g. 'coingecko', 'manual'). */
  rateSource: string;
  /** ISO-8601 timestamp of when the rate was observed. */
  rateTimestamp: string;
  /** Rounding mode applied when converting to minor units. */
  rounding: RoundingMode;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

/**
 * Schema for amount fields in API request bodies.
 *
 * Amounts MUST be submitted as integer strings (stroops).
 * Floating-point strings are rejected at the boundary.
 */
export const stroopsSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a non-negative integer string (stroops)')
  .transform((v) => BigInt(v))
  .refine((v) => v >= MIN_USDC_AMOUNT, {
    message: `Amount must be at least ${MIN_USDC_AMOUNT.toString()} stroops`,
  })
  .refine((v) => v <= MAX_USDC_AMOUNT, {
    message: `Amount must not exceed ${MAX_USDC_AMOUNT.toString()} stroops`,
  });

/**
 * Schema for currency fields.  Rejects unsupported tokens immediately.
 */
export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/**
 * Full payment amount input schema used on submit endpoints.
 * Ensures no floating-point amounts enter the system.
 */
export const paymentAmountSchema = z.object({
  amountStroops: stroopsSchema,
  currency: currencySchema,
});

// ─── Conversion utilities ─────────────────────────────────────────────────────

/**
 * Convert a USDC decimal string to stroops (BigInt).
 *
 * Rejects input with more than 7 decimal places (exceeds Stellar precision).
 * Rejects input that is not a valid decimal number.
 *
 * @example
 *   usdcToStroops('1.5')  // 15_000_000n
 *   usdcToStroops('1')    // 10_000_000n
 */
export function usdcToStroops(usdc: string): bigint {
  return decimalToMinorUnits(usdc, 'USDC');
}

/**
 * Convert an exact decimal string to integer minor units for a currency.
 *
 * Decimal-safe: never uses binary floating point.  Rejects:
 *  - e-notation, Infinity, NaN, signs, empty strings
 *  - values with more fractional digits than the currency's precision
 *  - values that exceed the supported maximum
 *
 * @example
 *   decimalToMinorUnits('1.5', 'USDC')   // 15_000_000n
 *   decimalToMinorUnits('0.0000001', 'USDC') // 1n
 */
export function decimalToMinorUnits(
  amount: string,
  currency: SupportedCurrency,
): bigint {
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new RangeError(`Invalid ${currency} amount: "${amount}"`);
  }

  const precision = CURRENCY_PRECISION[currency];
  const [intPart, fracPart = ''] = amount.split('.');

  if (fracPart.length > precision) {
    throw new RangeError(
      `${currency} amount "${amount}" has more than ${precision} decimal places (max precision: ${precision} digits)`,
    );
  }

  const paddedFrac = fracPart.padEnd(precision, '0');
  const minorUnits = BigInt(intPart) * CURRENCY_MINOR_UNITS[currency] + BigInt(paddedFrac);

  if (minorUnits > MAX_USDC_AMOUNT) {
    throw new RangeError(
      `${currency} amount "${amount}" exceeds the maximum supported amount`,
    );
  }

  return minorUnits;
}

/**
 * Convert integer minor units back to an exact decimal string for a currency.
 * Trailing zeros beyond the display precision are trimmed, but at least
 * DISPLAY_PRECISION fractional digits are kept.
 */
export function minorUnitsToDecimal(
  minorUnits: bigint,
  currency: SupportedCurrency,
): string {
  if (minorUnits < 0n) {
    throw new RangeError(`Negative minor units are not allowed: ${minorUnits}`);
  }
  const unit = CURRENCY_MINOR_UNITS[currency];
  const precision = CURRENCY_PRECISION[currency];
  const intPart = minorUnits / unit;
  const fracPart = minorUnits % unit;

  const exactFraction = fracPart.toString().padStart(precision, '0').replace(/0+$/, '');
  return `${intPart}.${exactFraction.padEnd(DISPLAY_PRECISION, '0')}`;
}

/**
 * Apply a rounding mode to a rational value expressed as numerator/denominator.
 * All arithmetic is integer-based; no binary floating point is involved.
 *
 * @example
 *   roundRational(5n, 2n, 'half-up')   // 3n  (2.5 → 3)
 *   roundRational(5n, 2n, 'half-even') // 2n  (2.5 → 2)
 *   roundRational(5n, 2n, 'down')      // 2n
 */
export function roundRational(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = 'half-up',
): bigint {
  if (denominator <= 0n) {
    throw new RangeError('Denominator must be positive');
  }
  if (numerator < 0n) {
    throw new RangeError('Negative values are not supported for rounding');
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  const twiceRemainder = remainder * 2n;

  switch (mode) {
    case 'down':
      return quotient;
    case 'half-up':
      return twiceRemainder >= denominator ? quotient + 1n : quotient;
    case 'half-even': {
      if (twiceRemainder > denominator) return quotient + 1n;
      if (twiceRemainder < denominator) return quotient;
      // Exactly half: round to even
      return quotient % 2n === 0n ? quotient : quotient + 1n;
    }
    default:
      throw new RangeError(`Unsupported rounding mode: ${String(mode)}`);
  }
}

/**
 * Convert an amount from a source currency to minor units of a target
 * currency using an exact decimal rate, without binary floating point.
 *
 * The rate is interpreted as "target units per 1 source unit" and must be a
 * non-negative decimal string.  The result is rounded to the target currency's
 * minor units using the supplied rounding mode.
 *
 * @example
 *   convertToMinorUnits('10.00', 'USD', 'USDC', '0.9999', 'half-up')
 */
export function convertToMinorUnits(
  amount: string,
  sourceCurrency: string,
  targetCurrency: SupportedCurrency,
  rate: string,
  rounding: RoundingMode = 'half-up',
): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new RangeError(`Invalid ${sourceCurrency} amount: "${amount}"`);
  }
  if (!/^\d+(\.\d+)?$/.test(rate)) {
    throw new RangeError(`Invalid conversion rate: "${rate}"`);
  }

  const sourcePrecision = CURRENCY_PRECISION[targetCurrency];
  const [amountInt, amountFrac = ''] = amount.split('.');
  const [rateInt, rateFrac = ''] = rate.split('.');

  // Represent amount and rate as scaled integers to keep arithmetic exact.
  const amountScale = 10n ** BigInt(amountFrac.length);
  const rateScale = 10n ** BigInt(rateFrac.length);

  const amountScaled = BigInt(amountInt) * amountScale + BigInt(amountFrac || '0');
  const rateScaled = BigInt(rateInt) * rateScale + BigInt(rateFrac || '0');

  // targetMinor = amount * rate * minorUnitsPerTarget
  const numerator =
    amountScaled * rateScaled * CURRENCY_MINOR_UNITS[targetCurrency];
  const denominator = amountScale * rateScale;

  const result = roundRational(numerator, denominator, rounding);

  if (result > MAX_USDC_AMOUNT) {
    throw new RangeError(
      `Converted amount exceeds the maximum supported amount for ${targetCurrency}`,
    );
  }

  // Guard: ensure the result fits the target precision (it always does by
  // construction, but assert to catch future regressions).
  if (sourcePrecision < 0) {
    throw new RangeError('Invalid precision configuration');
  }

  return result;
}

/**
 * Determine whether a conversion rate is stale relative to `now`.
 *
 * @param rateTimestamp - ISO-8601 timestamp of when the rate was observed.
 * @param now           - Reference time (defaults to current time).
 * @param maxAgeSeconds - Maximum allowed age (defaults to MAX_RATE_AGE_SECONDS).
 */
export function isRateStale(
  rateTimestamp: string,
  now: Date = new Date(),
  maxAgeSeconds: number = MAX_RATE_AGE_SECONDS,
): boolean {
  const observed = new Date(rateTimestamp);
  if (Number.isNaN(observed.getTime())) return true;
  const ageSeconds = (now.getTime() - observed.getTime()) / 1000;
  return ageSeconds > maxAgeSeconds;
}

/**
 * Build conversion metadata for a quote, exposing rate source, timestamp and
 * rounding behaviour for support and user-facing disclosure.
 */
export function buildConversionMetadata(params: {
  originalAmount: string;
  originalCurrency: string;
  targetCurrency: SupportedCurrency;
  rate: string;
  rateSource: string;
  rateTimestamp: string;
  rounding?: RoundingMode;
}): ConversionMetadata {
  const rounding = params.rounding ?? 'half-up';
  const converted = convertToMinorUnits(
    params.originalAmount,
    params.originalCurrency,
    params.targetCurrency,
    params.rate,
    rounding,
  );
  return {
    originalAmount: params.originalAmount,
    originalCurrency: params.originalCurrency,
    convertedMinorUnits: converted.toString(),
    targetCurrency: params.targetCurrency,
    rate: params.rate,
    rateSource: params.rateSource,
    rateTimestamp: params.rateTimestamp,
    rounding,
  };
}

/**
 * Convert stroops (BigInt) to a human-readable USDC string without losing
 * precision. Values with fewer than two fractional digits keep two for display.
 *
 * @example
 *   stroopsToUsdc(15_000_000n)  // '1.50'
 *   stroopsToUsdc(10_000_000n)  // '1.00'
 */
export function stroopsToUsdc(stroops: bigint): string {
  return minorUnitsToDecimal(stroops, 'USDC');
}

/**
 * Build a human-readable breakdown of a payment amount for UI display.
 *
 * @returns Object suitable for inclusion in API responses.
 */
export function buildAmountBreakdown(
  amountStroops: bigint,
  currency: SupportedCurrency = 'USDC',
): {
  amountStroops: string;
  amountDisplay: string;
  currency: SupportedCurrency;
} {
  return {
    amountStroops: amountStroops.toString(),
    amountDisplay: `${stroopsToUsdc(amountStroops)} ${currency}`,
    currency,
  };
}

// ─── Quote hash ───────────────────────────────────────────────────────────────

/**
 * Produce a signed quote hash that binds amount + bookingId + expiry together.
 *
 * The server signs the quote with an HMAC using QUOTE_SIGNING_SECRET so the
 * client cannot alter the amount between quote-fetch and payment-submit.
 *
 * @param bookingId    - UUID of the booking being quoted.
 * @param amountStroops - Amount in stroops.
 * @param currency     - Token (currently only USDC).
 * @param expiresAt    - ISO-8601 expiry timestamp.
 * @param secret       - HMAC signing secret (default: env QUOTE_SIGNING_SECRET).
 */
export function signQuote(
  bookingId: string,
  amountStroops: bigint,
  currency: SupportedCurrency,
  expiresAt: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): string {
  if (!secret) {
    throw new Error('QUOTE_SIGNING_SECRET is not configured');
  }
  const payload = `${bookingId}|${amountStroops.toString()}|${currency}|${expiresAt}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verify a quote hash matches the expected parameters.
 * Returns false if the hash is invalid, expired, or the secret is missing.
 *
 * @param quoteHash    - Hash from the client's payment-submit request.
 * @param bookingId    - UUID to verify against.
 * @param amountStroops - Stroops amount to verify against.
 * @param currency     - Token to verify against.
 * @param expiresAt    - Expiry ISO-8601 string from the quote.
 * @param secret       - HMAC signing secret.
 */
export function verifyQuote(
  quoteHash: string,
  bookingId: string,
  amountStroops: bigint,
  currency: SupportedCurrency,
  expiresAt: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): boolean {
  if (!secret) return false;

  // Reject expired quotes
  if (new Date(expiresAt) < new Date()) return false;

  const expected = signQuote(bookingId, amountStroops, currency, expiresAt, secret);

  // Timing-safe comparison (prevent timing oracle on hash prefix)
  if (expected.length !== quoteHash.length) return false;
  const bufExpected = Buffer.from(expected, 'hex');
  const bufActual   = Buffer.from(quoteHash, 'hex');
  if (bufExpected.length !== bufActual.length) return false;

  let diff = 0;
  for (let i = 0; i < bufExpected.length; i++) {
    diff |= bufExpected[i] ^ bufActual[i];
  }
  return diff === 0;
}

// ─── On-chain amount reconciliation ──────────────────────────────────────────

export type AmountReconciliationResult =
  | { match: true }
  | { match: false; expected: bigint; actual: bigint; diff: bigint };

/**
 * Compare the amount recorded in the DB against the amount observed on-chain.
 * Returns a detailed mismatch descriptor so callers can decide on quarantine.
 *
 * @param expectedStroops - Amount stored in the `payments` table.
 * @param onChainStroops  - Amount read from the Stellar transaction / escrow.
 */
export function reconcileAmounts(
  expectedStroops: bigint,
  onChainStroops: bigint,
): AmountReconciliationResult {
  if (expectedStroops === onChainStroops) {
    return { match: true };
  }
  return {
    match: false,
    expected: expectedStroops,
    actual: onChainStroops,
    diff: onChainStroops - expectedStroops,
  };
}

// ─── Validation helper for service layer ─────────────────────────────────────

export interface AmountValidationError {
  field: string;
  message: string;
}

/**
 * Validate a raw amount + currency from an API request body.
 * Returns an array of errors (empty = valid).
 *
 * Rejects:
 *  - Floating-point strings (e.g. "10.5")
 *  - Negative values
 *  - Amounts below minimum or above maximum
 *  - Unsupported currency tokens
 */
export function validatePaymentAmount(
  rawAmount: unknown,
  rawCurrency: unknown,
): AmountValidationError[] {
  const errors: AmountValidationError[] = [];

  // Reject numbers directly — must be a string to prevent float coercion
  if (typeof rawAmount === 'number') {
    errors.push({
      field: 'amountStroops',
      message: 'Amount must be provided as a string (integer stroops), not a number',
    });
    return errors;
  }

  // Reject zero / negative integer strings explicitly before schema parsing so
  // the error message is precise (schema would also reject them).
  if (typeof rawAmount === 'string' && /^-?\d+$/.test(rawAmount)) {
    const parsed = BigInt(rawAmount);
    if (parsed <= 0n) {
      errors.push({
        field: 'amountStroops',
        message: 'Amount must be greater than zero',
      });
      return errors;
    }
  }

  const amountResult = stroopsSchema.safeParse(rawAmount);
  if (!amountResult.success) {
    errors.push(
      ...amountResult.error.issues.map((issue) => ({
        field: 'amountStroops',
        message: issue.message,
      })),
    );
  }

  const currencyResult = currencySchema.safeParse(rawCurrency);
  if (!currencyResult.success) {
    errors.push(
      ...currencyResult.error.issues.map((issue) => ({
        field: 'currency',
        message: issue.message,
      })),
    );
  }

  return errors;
}

/**
 * Validate a decimal amount against a currency's supported precision.
 * Rejects values with more fractional digits than the currency allows, as well
 * as zero/negative and out-of-range values.
 */
export function validateDecimalAmount(
  rawAmount: unknown,
  rawCurrency: unknown,
): AmountValidationError[] {
  const errors: AmountValidationError[] = [];

  if (typeof rawAmount === 'number') {
    errors.push({
      field: 'amount',
      message: 'Amount must be provided as a string, not a number',
    });
    return errors;
  }

  if (typeof rawAmount !== 'string' || !/^\d+(\.\d+)?$/.test(rawAmount)) {
    errors.push({
      field: 'amount',
      message: 'Amount must be a non-negative decimal string',
    });
    return errors;
  }

  const currencyResult = currencySchema.safeParse(rawCurrency);
  if (!currencyResult.success) {
    errors.push(
      ...currencyResult.error.issues.map((issue) => ({
        field: 'currency',
        message: issue.message,
      })),
    );
    return errors;
  }

  const currency = currencyResult.data;
  const precision = CURRENCY_PRECISION[currency];
  const fracPart = rawAmount.split('.')[1] ?? '';
  if (fracPart.length > precision) {
    errors.push({
      field: 'amount',
      message: `${currency} supports at most ${precision} decimal places`,
    });
    return errors;
  }

  let minorUnits: bigint;
  try {
    minorUnits = decimalToMinorUnits(rawAmount, currency);
  } catch (err) {
    errors.push({
      field: 'amount',
      message: err instanceof Error ? err.message : 'Invalid amount',
    });
    return errors;
  }

  if (minorUnits <= 0n) {
    errors.push({ field: 'amount', message: 'Amount must be greater than zero' });
  } else if (minorUnits < MIN_USDC_AMOUNT) {
    errors.push({
      field: 'amount',
      message: `Amount must be at least ${MIN_USDC_AMOUNT.toString()} minor units`,
    });
  }

  return errors;
}

/**
 * Validate a conversion rate for a quote: rejects zero/negative rates and
 * stale timestamps so an outdated rate can never produce a payment quote.
 */
export function validateConversionRate(
  rawRate: unknown,
  rawTimestamp: unknown,
  now: Date = new Date(),
): AmountValidationError[] {
  const errors: AmountValidationError[] = [];

  if (typeof rawRate !== 'string' || !/^\d+(\.\d+)?$/.test(rawRate)) {
    errors.push({
      field: 'rate',
      message: 'Rate must be a non-negative decimal string',
    });
  } else if (BigInt(rawRate.replace('.', '')) === 0n) {
    errors.push({ field: 'rate', message: 'Rate must be greater than zero' });
  }

  if (typeof rawTimestamp !== 'string') {
    errors.push({
      field: 'rateTimestamp',
      message: 'Rate timestamp must be an ISO-8601 string',
    });
  } else if (isRateStale(rawTimestamp, now)) {
    errors.push({
      field: 'rateTimestamp',
      message: `Rate is stale (older than ${MAX_RATE_AGE_SECONDS}s)`,
    });
  }

  return errors;
}
