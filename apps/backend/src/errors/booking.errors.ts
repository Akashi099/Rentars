// Error codes for booking operations
export enum BookingErrorCode {
  PROPERTY_NOT_FOUND = 'PROPERTY_NOT_FOUND',
  BOOKING_OVERLAP = 'BOOKING_OVERLAP',
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
