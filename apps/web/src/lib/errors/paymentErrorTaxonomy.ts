/**
 * Payment error taxonomy.
 *
 * Classifies errors from the wallet (Freighter), the Stellar network, and the
 * Rentars backend into a small set of user-facing categories. Each category
 * carries a safe, copy-ready user message and a set of flags that drive the
 * UI: whether the user may retry, what action to suggest, and whether the
 * error is terminal (no recovery path).
 *
 * Safe means: no stack traces, no internal contract addresses, no XDR blobs,
 * no secrets, and no implied success for a payment that has not been confirmed.
 */

import { FreighterError } from '@/lib/freighter-utils';

// ─── Category type ───────────────────────────────────────────────────────────

export type PaymentErrorCategory =
  | 'wallet_rejection'   // user explicitly declined in Freighter
  | 'timeout'            // signing window expired; funds untouched
  | 'network'            // wrong network / mismatch
  | 'funds'              // insufficient USDC balance
  | 'provider'           // Stellar / Trustless Work / backend transient error
  | 'confirmed_duplicate' // payment already confirmed; retry would double-charge
  | 'circuit_open';      // payment system paused by circuit breaker

// ─── Classification result ───────────────────────────────────────────────────

export type SuggestedAction =
  | 'retry'
  | 'change_wallet'
  | 'cancel'
  | 'contact_support'
  | 'none';

export interface PaymentErrorClassification {
  /** Bucketed category used by UI to pick the right copy and actions. */
  category: PaymentErrorCategory;
  /** Safe, human-readable message. Never contains raw error internals. */
  userMessage: string;
  /**
   * Whether the user may re-attempt the exact same payment without risk of
   * duplication. Always false when the payment status is 'submitted' or
   * 'confirmed'.
   */
  canRetry: boolean;
  /** The most useful next step to surface to the user. */
  suggestedAction: SuggestedAction;
  /**
   * True when there is no recoverable path and the user should contact
   * support or wait. canRetry is always false when isTerminal is true.
   */
  isTerminal: boolean;
}

// ─── Category definitions ────────────────────────────────────────────────────

const CATEGORY_DEFAULTS: Record<
  PaymentErrorCategory,
  Omit<PaymentErrorClassification, 'category'>
> = {
  wallet_rejection: {
    userMessage: 'Transaction declined in wallet. You can try again when ready.',
    canRetry: true,
    suggestedAction: 'retry',
    isTerminal: false,
  },
  timeout: {
    userMessage: 'Signing timed out. Your funds have not moved.',
    canRetry: true,
    suggestedAction: 'retry',
    isTerminal: false,
  },
  network: {
    userMessage:
      'Wrong network selected in Freighter. Please switch to the correct network and try again.',
    canRetry: false,
    suggestedAction: 'change_wallet',
    isTerminal: false,
  },
  funds: {
    userMessage: 'Insufficient USDC balance to complete this payment.',
    canRetry: false,
    suggestedAction: 'contact_support',
    isTerminal: true,
  },
  provider: {
    userMessage:
      'The payment network is temporarily unavailable. Try again in a few minutes.',
    canRetry: true,
    suggestedAction: 'retry',
    isTerminal: false,
  },
  confirmed_duplicate: {
    userMessage: 'This payment has already been confirmed.',
    canRetry: false,
    suggestedAction: 'none',
    isTerminal: true,
  },
  circuit_open: {
    userMessage:
      'Payments are temporarily paused due to network issues. Please try again later.',
    canRetry: false,
    suggestedAction: 'none',
    isTerminal: true,
  },
};

// ─── Freighter error code → category ────────────────────────────────────────

const FREIGHTER_CODE_TO_CATEGORY: Record<FreighterError['code'], PaymentErrorCategory> = {
  USER_REJECTED: 'wallet_rejection',
  TIMEOUT: 'timeout',
  NETWORK_MISMATCH: 'network',
  NOT_INSTALLED: 'network',
  NOT_CONNECTED: 'network',
  SIGN_FAILED: 'provider',
  NETWORK_ERROR: 'provider',
};

// ─── Backend / API error code → category ────────────────────────────────────

/**
 * Maps the `error.code` strings returned by the Rentars backend (and
 * blockchain error classes) to a PaymentErrorCategory.
 */
const BACKEND_CODE_TO_CATEGORY: Record<string, PaymentErrorCategory> = {
  // Escrow / contract
  ESCROW_FAILED: 'provider',
  ESCROW_CREATION_FAILED: 'provider',
  ESCROW_RELEASE_FAILED: 'provider',
  ESCROW_NOT_FOUND: 'provider',
  INVALID_ESCROW_STATE: 'provider',
  INSUFFICIENT_ESCROW_BALANCE: 'funds',

  // Booking
  INSUFFICIENT_FUNDS: 'funds',

  // Blockchain
  CONTRACT_ERROR: 'provider',
  TRANSACTION_ERROR: 'provider',
  SIMULATION_ERROR: 'provider',
  QUOTE_INVALIDATED: 'provider',
  BLOCKCHAIN_ERROR: 'provider',

  // Infrastructure
  REQUEST_TIMEOUT: 'timeout',
  RATE_LIMITED: 'circuit_open',
  INTERNAL_SERVER_ERROR: 'provider',

  // Payment-specific codes (also used by the frontend catalogue)
  PAYMENT_USER_REJECTED: 'wallet_rejection',
  PAYMENT_TIMEOUT: 'timeout',
  PAYMENT_NETWORK_MISMATCH: 'network',
  PAYMENT_INSUFFICIENT_FUNDS: 'funds',
  PAYMENT_TX_SUBMIT_FAILED: 'provider',
  PAYMENT_ALREADY_CONFIRMED: 'confirmed_duplicate',
  PAYMENT_CIRCUIT_OPEN: 'circuit_open',
  PAYMENT_ATTEMPT_LIMIT_EXCEEDED: 'circuit_open',
};

// ─── Status overrides ────────────────────────────────────────────────────────

/**
 * Backend payment status values that override the classification outcome
 * regardless of the underlying error.
 *
 * - 'confirmed'  → already succeeded; retry would duplicate the charge.
 * - 'submitted'  → XDR is on the network; must poll, not resubmit.
 */
const TERMINAL_PAYMENT_STATUSES = new Set(['confirmed', 'refunded']);
const SUBMITTED_PAYMENT_STATUS = 'submitted';

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * Classifies an arbitrary error value into a {@link PaymentErrorClassification}.
 *
 * @param err                 - Any thrown value (Error, string, unknown).
 * @param currentPaymentStatus - The latest known server-side payment status
 *                               ('pending' | 'submitted' | 'confirmed' | …).
 *                               When 'submitted', canRetry is forced to false
 *                               to prevent XDR resubmission.  When 'confirmed'
 *                               or 'refunded', the result is always
 *                               confirmed_duplicate / isTerminal=true.
 */
export function classifyPaymentError(
  err: unknown,
  currentPaymentStatus?: string,
): PaymentErrorClassification {
  // ── 1. Handle confirmed/refunded status regardless of error type ──────────
  if (currentPaymentStatus && TERMINAL_PAYMENT_STATUSES.has(currentPaymentStatus)) {
    return buildClassification('confirmed_duplicate');
  }

  // ── 2. Classify the error itself ──────────────────────────────────────────
  let category: PaymentErrorCategory = 'provider'; // safe fallback

  if (err instanceof FreighterError) {
    category = FREIGHTER_CODE_TO_CATEGORY[err.code] ?? 'provider';
  } else if (isErrorWithCode(err)) {
    category = BACKEND_CODE_TO_CATEGORY[err.code] ?? 'provider';
  } else if (err instanceof Error) {
    category = inferCategoryFromMessage(err.message);
  }

  const classification = buildClassification(category);

  // ── 3. Submitted status → block XDR resubmission ─────────────────────────
  if (currentPaymentStatus === SUBMITTED_PAYMENT_STATUS) {
    return {
      ...classification,
      canRetry: false,
      userMessage:
        classification.category === 'confirmed_duplicate'
          ? classification.userMessage
          : 'Your payment was submitted to the network. We are waiting for confirmation — please do not retry.',
      suggestedAction: 'none',
    };
  }

  return classification;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildClassification(category: PaymentErrorCategory): PaymentErrorClassification {
  return {
    category,
    ...CATEGORY_DEFAULTS[category],
  };
}

interface ErrorWithCode {
  code: string;
  message?: string;
}

function isErrorWithCode(err: unknown): err is ErrorWithCode {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as ErrorWithCode).code === 'string'
  );
}

/**
 * Last-resort heuristic: scan a lower-cased message for known keywords.
 * Only used when no structured code is available.
 */
function inferCategoryFromMessage(message: string): PaymentErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes('rejected') || lower.includes('declined')) return 'wallet_rejection';
  if (lower.includes('timed out') || lower.includes('timeout')) return 'timeout';
  if (lower.includes('network mismatch') || lower.includes('wrong network')) return 'network';
  if (lower.includes('insufficient') || lower.includes('balance')) return 'funds';
  if (lower.includes('already confirmed') || lower.includes('duplicate')) return 'confirmed_duplicate';
  if (lower.includes('circuit') || lower.includes('paused')) return 'circuit_open';
  return 'provider';
}
