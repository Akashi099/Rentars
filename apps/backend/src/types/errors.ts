/**
 * Stable machine-readable error codes for the Rentars API.
 *
 * Every error response includes an `error.code` field drawn from this module.
 * HTTP statuses are unchanged; codes add specificity within a status.
 *
 * Documented codes are listed below by category.  Frontend code should branch
 * on these strings rather than on HTTP status alone.
 *
 * @example Response shape
 * ```json
 * {
 *   "error": {
 *     "code": "BOOKING_OVERLAP",
 *     "message": "The property is already booked for those dates.",
 *     "details": { "conflictingBookingId": "abc-123" }
 *   }
 * }
 * ```
 */

// ─── Re-exports ────────────────────────────────────────────────────────────
import { BookingError } from '../errors/booking.errors.js';
import { PaymentError } from '../errors/payment.errors.js';
export { BookingError } from '../errors/booking.errors.js';
export {
  PaymentErrorCategory,
  PaymentNextAction,
  PaymentTransactionStatus,
  PaymentIdempotencyContext,
  mapToPaymentError,
  sanitizePaymentMessage,
  getAllowedPaymentActions,
  isResubmissionSafe,
} from '../errors/payment.errors.js';
export { PaymentError } from '../errors/payment.errors.js';

// ─── Escrow ─────────────────────────────────────────────────────────────────

/**
 * Escrow operation error codes.
 *
 * | Code | HTTP | Meaning |
 * |------|------|---------|
 * | ESCROW_CREATION_FAILED | 400 | Could not initialise the TrustlessWork escrow |
 * | ESCROW_RELEASE_FAILED | 400 | Escrow release to owner failed |
 * | ESCROW_NOT_FOUND | 404 | Escrow ID does not match any known record |
 * | INVALID_ESCROW_STATE | 400 | Operation not valid in current escrow state |
 * | INSUFFICIENT_ESCROW_BALANCE | 402 | Wallet balance too low to fund escrow |
 */
export enum EscrowErrorCode {
  ESCROW_CREATION_FAILED = 'ESCROW_CREATION_FAILED',
  ESCROW_RELEASE_FAILED = 'ESCROW_RELEASE_FAILED',
  ESCROW_NOT_FOUND = 'ESCROW_NOT_FOUND',
  INVALID_ESCROW_STATE = 'INVALID_ESCROW_STATE',
  INSUFFICIENT_ESCROW_BALANCE = 'INSUFFICIENT_ESCROW_BALANCE',
}

export class EscrowError extends Error {
  constructor(
    public code: EscrowErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EscrowError';
    Object.setPrototypeOf(this, EscrowError.prototype);
  }
}

// ─── Property ────────────────────────────────────────────────────────────────

/**
 * Property operation error codes.
 *
 * | Code | HTTP | Meaning |
 * |------|------|---------|
 * | PROPERTY_NOT_FOUND | 404 | No property matches the supplied ID |
 * | UNAUTHORIZED_OWNER | 403 | Caller is not the property owner |
 * | INVALID_PROPERTY_DATA | 400 | Property payload failed schema validation |
 */
export enum PropertyErrorCode {
  PROPERTY_NOT_FOUND = 'PROPERTY_NOT_FOUND',
  UNAUTHORIZED_OWNER = 'UNAUTHORIZED_OWNER',
  INVALID_PROPERTY_DATA = 'INVALID_PROPERTY_DATA',
}

export class PropertyError extends Error {
  constructor(
    public code: PropertyErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PropertyError';
    Object.setPrototypeOf(this, PropertyError.prototype);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Authentication / authorisation error codes.
 *
 * | Code | HTTP | Meaning |
 * |------|------|---------|
 * | INVALID_CREDENTIALS | 401 | Wrong email or password |
 * | USER_NOT_FOUND | 404 | No account for the supplied identifier |
 * | USER_ALREADY_EXISTS | 409 | Registration attempted with a duplicate email |
 * | INVALID_TOKEN | 401 | JWT is malformed or has an invalid signature |
 * | TOKEN_EXPIRED | 401 | JWT has passed its expiry date |
 * | UNAUTHORIZED | 403 | Caller is authenticated but lacks permission |
 */
export enum AuthErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  UNAUTHORIZED = 'UNAUTHORIZED',
}

export class AuthError extends Error {
  constructor(
    public code: AuthErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AuthError';
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

export class ValidationError extends Error {
  constructor(
    public message: string,
    public fields: Record<string, string[]> = {},
  ) {
    super(message);
    this.name = 'ValidationError';
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export type DomainError =
  | BookingError
  | EscrowError
  | PropertyError
  | AuthError
  | ValidationError
  | PaymentError;

export function isDomainError(error: unknown): error is DomainError {
  return (
    error instanceof BookingError ||
    error instanceof EscrowError ||
    error instanceof PropertyError ||
    error instanceof AuthError ||
    error instanceof ValidationError ||
    error instanceof PaymentError
  );
}
