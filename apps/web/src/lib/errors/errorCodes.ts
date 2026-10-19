/**
 * Stable machine-readable error codes returned by the Rentars API.
 *
 * Every error response from the backend carries `error.code` as one of these
 * string literals.  UI code should branch on `code` rather than on HTTP
 * status or free-form `message` strings so that user-facing copy can be
 * localised and updated independently.
 *
 * @example
 * const { code } = await res.json().error;
 * const message = getErrorMessage(code);
 */

// ─── Code catalogue ─────────────────────────────────────────────────────────

export const ErrorCode = {
  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',

  // Booking
  PROPERTY_NOT_FOUND: 'PROPERTY_NOT_FOUND',
  BOOKING_OVERLAP: 'BOOKING_OVERLAP',
  ESCROW_FAILED: 'ESCROW_FAILED',
  INVALID_DATES: 'INVALID_DATES',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  INVALID_STATUS: 'INVALID_STATUS',

  // Escrow
  ESCROW_CREATION_FAILED: 'ESCROW_CREATION_FAILED',
  ESCROW_RELEASE_FAILED: 'ESCROW_RELEASE_FAILED',
  ESCROW_NOT_FOUND: 'ESCROW_NOT_FOUND',
  INVALID_ESCROW_STATE: 'INVALID_ESCROW_STATE',
  INSUFFICIENT_ESCROW_BALANCE: 'INSUFFICIENT_ESCROW_BALANCE',

  // Property
  UNAUTHORIZED_OWNER: 'UNAUTHORIZED_OWNER',
  INVALID_PROPERTY_DATA: 'INVALID_PROPERTY_DATA',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_DATE_FORMAT: 'INVALID_DATE_FORMAT',

  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',

  // Infrastructure
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',

  // Payment (wallet + escrow flow)
  PAYMENT_USER_REJECTED: 'PAYMENT_USER_REJECTED',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  PAYMENT_NETWORK_MISMATCH: 'PAYMENT_NETWORK_MISMATCH',
  PAYMENT_INSUFFICIENT_FUNDS: 'PAYMENT_INSUFFICIENT_FUNDS',
  PAYMENT_TX_SUBMIT_FAILED: 'PAYMENT_TX_SUBMIT_FAILED',
  PAYMENT_ALREADY_CONFIRMED: 'PAYMENT_ALREADY_CONFIRMED',
  PAYMENT_CIRCUIT_OPEN: 'PAYMENT_CIRCUIT_OPEN',
  PAYMENT_ATTEMPT_LIMIT_EXCEEDED: 'PAYMENT_ATTEMPT_LIMIT_EXCEEDED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── User-friendly messages ──────────────────────────────────────────────────

/**
 * Maps an API error code to a human-readable message suitable for display.
 * Falls back to the raw server `message` (or a generic string) when the code
 * is not recognised.
 */
const ERROR_MESSAGES: Record<ErrorCodeValue, string> = {
  // Auth
  INVALID_CREDENTIALS: 'Incorrect email or password. Please try again.',
  USER_NOT_FOUND: 'No account found with those details.',
  USER_ALREADY_EXISTS: 'An account with this email already exists.',
  INVALID_TOKEN: 'Your session is invalid. Please sign in again.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  UNAUTHORIZED: "You don't have permission to perform this action.",

  // Booking
  PROPERTY_NOT_FOUND: 'This property could not be found.',
  BOOKING_OVERLAP: 'These dates are already booked. Please choose different dates.',
  ESCROW_FAILED: 'The escrow transaction failed. Please try again.',
  INVALID_DATES: 'The selected dates are invalid. Check-out must be after check-in.',
  INSUFFICIENT_FUNDS: 'Insufficient USDC balance to complete this booking.',
  BOOKING_NOT_FOUND: 'This booking could not be found.',
  INVALID_STATUS: 'This action cannot be performed in the current booking status.',

  // Escrow
  ESCROW_CREATION_FAILED: 'We could not set up the escrow. Please try again.',
  ESCROW_RELEASE_FAILED: 'The escrow release failed. Please contact support.',
  ESCROW_NOT_FOUND: 'Escrow details could not be found.',
  INVALID_ESCROW_STATE: 'This escrow action is not valid right now.',
  INSUFFICIENT_ESCROW_BALANCE: 'The escrow balance is too low to complete this action.',

  // Property
  UNAUTHORIZED_OWNER: 'Only the property owner can perform this action.',
  INVALID_PROPERTY_DATA: 'The property information is invalid. Please check your details.',

  // Validation
  VALIDATION_ERROR: 'Some fields are invalid. Please review your input.',
  MISSING_REQUIRED_FIELD: 'A required field is missing. Please fill in all required information.',
  INVALID_DATE_FORMAT: 'One or more dates are in an invalid format.',

  // Rate limiting
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',

  // Infrastructure
  REQUEST_TIMEOUT: 'The request took too long. Please try again.',
  INTERNAL_SERVER_ERROR: 'Something went wrong on our end. Please try again later.',

  // Payment (wallet + escrow flow)
  PAYMENT_USER_REJECTED: 'Transaction declined in wallet. You can try again when ready.',
  PAYMENT_TIMEOUT: 'Signing timed out. Your funds have not moved.',
  PAYMENT_NETWORK_MISMATCH: 'Wrong network selected in Freighter. Please switch to the correct network and try again.',
  PAYMENT_INSUFFICIENT_FUNDS: 'Insufficient USDC balance to complete this payment.',
  PAYMENT_TX_SUBMIT_FAILED: 'The payment network is temporarily unavailable. Try again in a few minutes.',
  PAYMENT_ALREADY_CONFIRMED: 'This payment has already been confirmed.',
  PAYMENT_CIRCUIT_OPEN: 'Payments are temporarily paused due to network issues. Please try again later.',
  PAYMENT_ATTEMPT_LIMIT_EXCEEDED: 'Too many payment attempts. Please wait a moment before trying again.',
};

/**
 * Returns a user-friendly message for the given API error code.
 *
 * @param code - The `error.code` from an API error response.
 * @param fallback - Fallback string when `code` is not in the catalogue
 *                   (e.g. the raw server `error.message`).
 */
export function getErrorMessage(
  code: string | undefined | null,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!code) return fallback;
  return ERROR_MESSAGES[code as ErrorCodeValue] ?? fallback;
}

// ─── Type-safe API error shape ───────────────────────────────────────────────

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Narrow-check that an unknown fetch response body is an {@link ApiErrorResponse}.
 */
export function isApiError(body: unknown): body is ApiErrorResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as ApiErrorResponse).error?.code === 'string'
  );
}
