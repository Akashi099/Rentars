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
  // Reject floating-point edge cases: e-notation, Infinity, NaN
  if (!/^\d+(\.\d+)?$/.test(usdc)) {
    throw new RangeError(`Invalid USDC amount: "${usdc}"`);
  }

  const [intPart, fracPart = ''] = usdc.split('.');

  if (fracPart.length > 7) {
    throw new RangeError(
      `USDC amount "${usdc}" has more than 7 decimal places (max precision: 0.0000001 USDC)`,
    );
  }

  const paddedFrac = fracPart.padEnd(7, '0');
  return BigInt(intPart) * STROOPS_PER_USDC + BigInt(paddedFrac);
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
  const intPart = stroops / STROOPS_PER_USDC;
  const fracPart = stroops % STROOPS_PER_USDC;

  const exactFraction = fracPart.toString().padStart(7, '0').replace(/0+$/, '');
  return `${intPart}.${exactFraction.padEnd(2, '0')}`;
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
