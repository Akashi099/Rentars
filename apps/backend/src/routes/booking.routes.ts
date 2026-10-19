import { Router } from 'express';
import {
  acceptModification,
  cancelBooking,
  completeBooking,
  confirmBooking,
  createBooking,
  declineModification,
  deleteBooking,
  disputeBooking,
  getBooking,
  getBookingCalendar,
  getBookingReceipt,
  getBookingStatusHistory,
  getRefundPreviewHandler,
  getRefundStatusHandler,
  listUserBookings,
  raiseDispute,
  requestModification,
  resolveDispute,
  updateBooking,
} from '@/controllers/booking.controller.js';
import { authenticate } from '@/middleware/auth.middleware.js';
import { requireEmailVerified } from '@/middleware/emailVerified.middleware.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';
import {
  cancelBookingSchema,
  createBookingSchema,
  raiseDisputeSchema,
  requestModificationSchema,
  resolveDisputeSchema,
  updateBookingSchema,
  validateBody,
} from '@/validators/booking.validator.js';
import { env } from '@/config/env.js';
import { validatePagination } from '@/validators/pagination.validator.js';

const router = Router();

/**
 * Per-user rate limiter for booking creation.
 * Keyed on the authenticated user id — two users sharing a NAT/IP are
 * tracked independently. Thresholds are configurable via env vars:
 *   BOOKING_RATE_LIMIT_WINDOW_MS  (default: 60 000 ms)
 *   BOOKING_RATE_LIMIT_MAX        (default: 5 requests)
 */
const bookingCreationLimiter = createUserRateLimiter({
  windowMs: env.BOOKING_RATE_LIMIT_WINDOW_MS,
  max: env.BOOKING_RATE_LIMIT_MAX,
  keyPrefix: 'rl:user:booking',
});

// GET /api/v1/bookings — list current user's bookings (cursor pagination)
router.get('/', authenticate, validatePagination, listUserBookings);

// GET /api/v1/bookings/:id
router.get('/:id', authenticate, getBooking);

// GET /api/v1/bookings/:id/status-history
router.get('/:id/status-history', authenticate, getBookingStatusHistory);

// GET /api/v1/bookings/:id/calendar.ics
router.get('/:id/calendar.ics', authenticate, getBookingCalendar);

// GET /api/v1/bookings/:id/receipt.pdf
router.get('/:id/receipt.pdf', authenticate, getBookingReceipt);

// POST /api/v1/bookings  (requires email verification)
router.post(
  '/',
  authenticate,
  requireEmailVerified,
  bookingCreationLimiter,
  validateBody(createBookingSchema),
  createBooking,
);

// POST /api/v1/bookings/:id/confirm
// Tenant confirms check-in → releases escrow to host → status: Confirmed
router.post('/:id/confirm', authenticate, confirmBooking);

// POST /api/v1/bookings/:id/complete
// Tenant marks stay as completed → status: Completed
router.post('/:id/complete', authenticate, completeBooking);

// POST /api/v1/bookings/:id/dispute
// Tenant raises a dispute → status: Disputed (escrow held)
// Body: { reason?: string }
router.post('/:id/dispute', authenticate, disputeBooking);

// POST /api/v1/bookings/:id/cancel
// Tenant cancels a booking → refund computed from booking-time snapshot → escrow settled → both parties notified
// Body (optional): { reason?: string }
router.post('/:id/cancel', authenticate, validateBody(cancelBookingSchema), cancelBooking);

// GET /api/v1/bookings/:id/refund-preview
// Shows the refund calculation from the booking-time policy snapshot *before*
// the tenant confirms cancellation.  Does not modify any state. (#769)
router.get('/:id/refund-preview', authenticate, getRefundPreviewHandler);

// GET /api/v1/bookings/:id/refund
// Returns the current refund request status (requested/submitted/confirmed/failed/manual_review). (#769)
router.get('/:id/refund', authenticate, getRefundStatusHandler);

// POST /api/v1/bookings/:id/dispute
router.post('/:id/dispute', authenticate, validateBody(raiseDisputeSchema), raiseDispute);

// POST /api/v1/bookings/:id/dispute/resolve
router.post('/:id/dispute/resolve', authenticate, validateBody(resolveDisputeSchema), resolveDispute);

// PATCH /api/v1/bookings/:id
router.patch('/:id', authenticate, validateBody(updateBookingSchema), updateBooking);

// DELETE /api/v1/bookings/:id
router.delete('/:id', authenticate, deleteBooking);

// POST /api/v1/bookings/:id/modifications
// Tenant requests a date change → status: pending
router.post('/:id/modifications', authenticate, validateBody(requestModificationSchema), requestModification);

// POST /api/v1/bookings/:id/modifications/:modId/accept
// Host accepts the date-change request
router.post('/:id/modifications/:modId/accept', authenticate, acceptModification);

// POST /api/v1/bookings/:id/modifications/:modId/decline
// Host declines the date-change request
router.post('/:id/modifications/:modId/decline', authenticate, declineModification);

export default router;
