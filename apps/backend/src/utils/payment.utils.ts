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

/** Minimum accepted USDC amount: 0.01 USDC. */
export const MIN_USDC_AMOUNT = 1_000n; // 0.0001 USDC actually; practical min

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
 * Convert stroops (BigInt) to a human-readable USDC string with 2 decimal places.
 *
 * @example
 *   stroopsToUsdc(15_000_000n)  // '1.50'
 *   stroopsToUsdc(10_000_000n)  // '1.00'
 */
export function stroopsToUsdc(stroops: bigint): string {
  const intPart = stroops / STROOPS_PER_USDC;
  const fracPart = stroops % STROOPS_PER_USDC;

  // Show 2 decimal places (USDC display convention)
  const fracStr = fracPart.toString().padStart(7, '0').slice(0, 2);
  const roundedFrac = Math.round(Number(fracPart) / 100_000)
    .toString()
    .padStart(2, '0');
  return `${intPart}.${roundedFrac}`;
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

// ─── Payment error taxonomy (#771) ───────────────────────────────────────────

/**
 * Stable, internal error categories for payment failures.
 *
 * Each category maps to a distinct user-facing message and a distinct set of
 * safe next actions.  Never surface raw provider/RPC errors to users — map
 * them through this taxonomy first.
 */
export const PAYMENT_ERROR_CATEGORIES = [
  'wallet_rejected',
  'insufficient_funds',
  'rpc_failure',
  'provider_timeout',
  'contract_rejection',
  'quote_invalid',
  'amount_mismatch',
  'unknown',
] as const;

export type PaymentErrorCategory = (typeof PAYMENT_ERROR_CATEGORIES)[number];

/**
 * Transaction lifecycle status as observed by the backend.
 *
 * `signed` and `submitted` are terminal for resubmission purposes: a signed
 * transaction must never be re-signed or re-submitted (it may already be
 * in-flight on-chain), so only status-checking actions are safe.
 */
export const PAYMENT_TRANSACTION_STATUSES = [
  'draft',
  'quoted',
  'signed',
  'submitted',
  'pending_confirmation',
  'confirmed',
  'failed',
  'under_review',
] as const;

export type PaymentTransactionStatus = (typeof PAYMENT_TRANSACTION_STATUSES)[number];

/** Actions the UI may offer for a failed payment. */
export const PAYMENT_RECOVERY_ACTIONS = [
  'retry',
  'change_wallet',
  'cancel',
  'contact_support',
  'check_status',
] as const;

export type PaymentRecoveryAction = (typeof PAYMENT_RECOVERY_ACTIONS)[number];

export interface PaymentErrorDescriptor {
  category: PaymentErrorCategory;
  /** Safe, user-facing message. Never contains secrets, XDRs, or stack traces. */
  message: string;
  /** Whether the user may safely attempt the payment again. */
  recoverable: boolean;
  /** Actions safe to offer for this category, before status filtering. */
  suggestedActions: PaymentRecoveryAction[];
}

const PAYMENT_ERROR_DESCRIPTORS: Record<PaymentErrorCategory, PaymentErrorDescriptor> = {
  wallet_rejected: {
    category: 'wallet_rejected',
    message:
      'The payment was cancelled in your wallet. No funds were moved. You can try again when ready.',
    recoverable: true,
    suggestedActions: ['retry', 'change_wallet', 'cancel'],
  },
  insufficient_funds: {
    category: 'insufficient_funds',
    message:
      'Your wallet does not have enough USDC to complete this payment. Add funds or switch wallets, then try again.',
    recoverable: true,
    suggestedActions: ['retry', 'change_wallet', 'cancel'],
  },
  rpc_failure: {
    category: 'rpc_failure',
    message:
      'We could not reach the payment network. Your payment was not confirmed. Please retry in a moment.',
    recoverable: true,
    suggestedActions: ['retry', 'check_status', 'contact_support'],
  },
  provider_timeout: {
    category: 'provider_timeout',
    message:
      'The payment provider took too long to respond. Your payment status is unknown — check the status before retrying.',
    recoverable: true,
    suggestedActions: ['check_status', 'contact_support'],
  },
  contract_rejection: {
    category: 'contract_rejection',
    message:
      'The payment contract rejected this transaction. No funds were moved. Please review the details and try again.',
    recoverable: true,
    suggestedActions: ['retry', 'change_wallet', 'contact_support'],
  },
  quote_invalid: {
    category: 'quote_invalid',
    message:
      'This payment quote has expired or is no longer valid. Please request a new quote to continue.',
    recoverable: true,
    suggestedActions: ['retry', 'cancel'],
  },
  amount_mismatch: {
    category: 'amount_mismatch',
    message:
      'The settled amount did not match the quoted amount. Your payment is under review and no booking has been marked paid.',
    recoverable: false,
    suggestedActions: ['contact_support'],
  },
  unknown: {
    category: 'unknown',
    message:
      'Something went wrong while processing your payment. Please check the payment status before trying again.',
    recoverable: false,
    suggestedActions: ['check_status', 'contact_support'],
  },
};

/**
 * Return the safe user-facing descriptor for a payment error category.
 * Unknown categories fall back to the `unknown` descriptor.
 */
export function getPaymentErrorDescriptor(
  category: PaymentErrorCategory | string,
): PaymentErrorDescriptor {
  const key = category as PaymentErrorCategory;
  const descriptor = PAYMENT_ERROR_DESCRIPTORS[key] ?? PAYMENT_ERROR_DESCRIPTORS.unknown;
  // Return a copy so callers cannot mutate the shared table.
  return { ...descriptor, suggestedActions: [...descriptor.suggestedActions] };
}

/**
 * Compute the actions that are safe to offer for a given error category and
 * transaction status.
 *
 * Safety rules:
 *  - `signed` / `submitted` / `pending_confirmation` transactions may already
 *    be in-flight on-chain, so `retry` and `change_wallet` are never offered
 *    (prevents duplicate payments).
 *  - `confirmed` transactions are never retried.
 *  - `retry` is only offered when the error is recoverable.
 */
export function getAllowedRecoveryActions(
  category: PaymentErrorCategory | string,
  status: PaymentTransactionStatus,
): PaymentRecoveryAction[] {
  const descriptor = getPaymentErrorDescriptor(category);
  const inFlight =
    status === 'signed' || status === 'submitted' || status === 'pending_confirmation';

  return descriptor.suggestedActions.filter((action) => {
    if (action === 'retry') {
      return descriptor.recoverable && !inFlight && status !== 'confirmed';
    }
    if (action === 'change_wallet') {
      return !inFlight && status !== 'confirmed';
    }
    if (action === 'cancel') {
      return status !== 'confirmed';
    }
    return true;
  });
}

/**
 * Whether a payment may be resubmitted for the given transaction status.
 * Signed/submitted transactions must never be resubmitted — they may already
 * be on-chain, and resubmission risks a duplicate payment.
 */
export function canResubmitPayment(status: PaymentTransactionStatus): boolean {
  return status === 'draft' || status === 'quoted' || status === 'failed';
}

// ─── Error text sanitization ─────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  // Stellar secret seeds (S... 56 chars)
  /\bS[A-Z2-7]{55}\b/g,
  // Transaction / envelope XDR (base64 blobs, typically long)
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
  // Hex-encoded hashes / signatures (64+ hex chars)
  /\b[0-9a-fA-F]{64,}\b/g,
  // Bearer tokens / API keys in headers
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  // key=value style secrets
  /\b(secret|private[_-]?key|api[_-]?key|token|password)\s*[:=]\s*\S+/gi,
];

/**
 * Sanitize arbitrary error text so it is safe to show to users or log.
 *
 * Removes Stellar secret seeds, XDR blobs, long hex signatures, bearer tokens,
 * and key=value secrets.  Truncates the result to a bounded length.
 */
export function sanitizePaymentErrorText(raw: unknown, maxLength = 300): string {
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw instanceof Error) {
    text = raw.message;
  } else {
    text = String(raw ?? '');
  }

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }

  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
  }
  return text;
}

/**
 * Build a complete, safe recovery payload for a failed payment.
 *
 * Combines the category descriptor, status-filtered actions, and a sanitized
 * diagnostic string.  The raw error is never returned to the client.
 */
export function buildPaymentFailureResponse(
  category: PaymentErrorCategory | string,
  status: PaymentTransactionStatus,
  rawError?: unknown,
): {
  category: PaymentErrorCategory;
  message: string;
  recoverable: boolean;
  allowedActions: PaymentRecoveryAction[];
  canResubmit: boolean;
  diagnostic?: string;
} {
  const descriptor = getPaymentErrorDescriptor(category);
  const diagnostic =
    rawError === undefined ? undefined : sanitizePaymentErrorText(rawError);

  return {
    category: descriptor.category,
    message: descriptor.message,
    recoverable: descriptor.recoverable,
    allowedActions: getAllowedRecoveryActions(descriptor.category, status),
    canResubmit: descriptor.recoverable && canResubmitPayment(status),
    ...(diagnostic ? { diagnostic } : {}),
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
