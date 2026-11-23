// Error codes for booking operations
export enum BookingErrorCode {
  PROPERTY_NOT_FOUND = 'PROPERTY_NOT_FOUND',
  BOOKING_OVERLAP = 'BOOKING_OVERLAP',
  BOOKING_CONFLICT = 'BOOKING_CONFLICT',
  ESCROW_FAILED = 'ESCROW_FAILED',
  INVALID_DATES = 'INVALID_DATES',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  BOOKING_NOT_FOUND = 'BOOKING_NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_STATUS = 'INVALID_STATUS',
  INVALID_TRANSITION = 'INVALID_TRANSITION',
}

export class BookingError extends Error {
  constructor(
    public code: BookingErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BookingError';
    Object.setPrototypeOf(this, BookingError.prototype);
  }
}

// Generic, non-disclosing message for booking conflicts. Must never include
// the conflicting booking's tenant, property, or date details.
export const BOOKING_CONFLICT_MESSAGE =
  'The requested dates are no longer available. Please choose different dates.';

// HTTP status mapping for booking error codes.
export function getBookingErrorHttpStatus(code: BookingErrorCode): number {
  switch (code) {
    case BookingErrorCode.PROPERTY_NOT_FOUND:
    case BookingErrorCode.BOOKING_NOT_FOUND:
      return 404;
    case BookingErrorCode.UNAUTHORIZED:
      return 403;
    case BookingErrorCode.BOOKING_OVERLAP:
    case BookingErrorCode.BOOKING_CONFLICT:
      return 409;
    case BookingErrorCode.INVALID_DATES:
    case BookingErrorCode.INVALID_STATUS:
    case BookingErrorCode.INVALID_TRANSITION:
      return 400;
    case BookingErrorCode.ESCROW_FAILED:
    case BookingErrorCode.INSUFFICIENT_FUNDS:
      return 402;
    default:
      return 500;
  }
}

// Sanitizes a booking error for client responses, ensuring conflict errors
// do not leak another tenant's information.
export function toBookingErrorResponse(error: BookingError): {
  status: number;
  body: { code: BookingErrorCode; message: string };
} {
  const status = getBookingErrorHttpStatus(error.code);
  if (
    error.code === BookingErrorCode.BOOKING_CONFLICT ||
    error.code === BookingErrorCode.BOOKING_OVERLAP
  ) {
    return {
      status,
      body: { code: error.code, message: BOOKING_CONFLICT_MESSAGE },
    };
  }
  return {
    status,
    body: { code: error.code, message: error.message },
  };
}