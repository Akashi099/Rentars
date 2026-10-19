import type { Request, Response } from 'express';
import type { Request, Response } from 'express';
import { BookingService } from '@/services/booking.service.js';
import { getPropertyById } from '@/services/property.service.js';
import { generateIcs } from '@/utils/ics.js';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import type { BookingModification } from '@/services/booking.service.js';
import { getRefundPreview, getRefundRequestByBooking } from '@/services/refund.service.js';

const bookingService = new BookingService();

export async function listUserBookings(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const pagination = (req as AuthRequest & { parsedPagination?: { page: number; pageSize: number } }).parsedPagination;
  const page = pagination?.page ?? Number(req.query.page ?? 1);
  const pageSize = pagination?.pageSize ?? Number(req.query.pageSize ?? req.query.limit ?? 20);

  const status = typeof req.query.status === 'string' ? req.query.status : null;

  const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : 'created';
  const sort = ['date', 'price', 'created'].includes(sortRaw) ? (sortRaw as 'date' | 'price' | 'created') : 'created';

  const orderRaw = typeof req.query.order === 'string' ? req.query.order : 'desc';
  const order = orderRaw === 'asc' ? 'asc' : 'desc';

  const result = await bookingService.getUserBookings(userId, page, pageSize, status, sort, order);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications
 *
 * Request a date change for a booking.
 * Only the booking tenant may request a modification.
 * Body: { requested_start: string, requested_end: string, reason?: string }
 */
export async function requestModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { requested_start, requested_end, reason } = req.body as {
    requested_start: string;
    requested_end: string;
    reason?: string;
  };

  const result = await bookingService.requestModification(
    req.params.id,
    authUser.id,
    requested_start,
    requested_end,
    reason,
  );

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : result.conflict ? 409
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications/:modId/accept
 *
 * Accept a pending date-change request.
 * Only the host (property owner) may accept.
 */
export async function acceptModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.acceptModification(req.params.id, authUser.id, req.params.modId);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found' || result.error === 'Modification request not found' ? 404
      : result.conflict ? 409
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/modifications/:modId/decline
 *
 * Decline a pending date-change request.
 * Only the host (property owner) may decline.
 */
export async function declineModification(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.declineModification(req.params.id, authUser.id, req.params.modId);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found' || result.error === 'Modification request not found' ? 404
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getBooking(req: Request, res: Response): Promise<void> {
  const result = await bookingService.getBookingById(req.params.id);

  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getBookingStatusHistory(req: Request, res: Response): Promise<void> {
  const result = await bookingService.getBookingStatusHistory(req.params.id);

  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function createBooking(req: Request, res: Response): Promise<void> {
  const authReq = req as AuthRequest;
  const userId = authReq.user?.id ?? authReq.userId;
  const idempotencyKey = req.headers['idempotency-key'];

  // ── Idempotency check ───────────────────────────────────────────────────────
  if (idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      res.status(400).json({ error: 'Idempotency-Key header must be a non-empty string' });
      return;
    }

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const requestHash = hashRequestBody(req.body);
    const existing = await lookup(userId, idempotencyKey.trim());

    if (!existing.success) {
      // DB error during lookup — fail safe (let the request proceed without
      // idempotency protection rather than blocking all bookings)
      console.error('[idempotency] lookup error:', existing.error);
    } else if (existing.data !== null) {
      const record = existing.data;

      if (record.request_hash !== requestHash) {
        // Same key, different payload → 422 Unprocessable Entity
        res.status(422).json({
          error:
            'Idempotency-Key has already been used with a different request payload. ' +
            'Use a new key for a different booking request.',
        });
        return;
      }

      // Matching key and hash → replay the original response
      res
        .status(record.status_code)
        .set('Idempotent-Replayed', 'true')
        .json(record.response_body);
      return;
    }
  }

  // ── Normal booking creation ─────────────────────────────────────────────────
  const result = await bookingService.createBooking(req.body);

  if (!result.success) {
    const status = result.conflict ? 409 : 400;
    res.status(status).json({ error: result.error });
    return;
  }

  const responseBody = result.data as Record<string, unknown>;
  const statusCode = 201;

  // ── Persist idempotency record ──────────────────────────────────────────────
  if (idempotencyKey && typeof idempotencyKey === 'string' && userId) {
    const requestHash = hashRequestBody(req.body);
    const storeResult = await store(userId, idempotencyKey.trim(), requestHash, responseBody, statusCode);
    if (!storeResult.success) {
      // Non-fatal: log but still return the booking response
      console.error('[idempotency] store error:', storeResult.error);
    }
  }

  res.status(statusCode).json(responseBody);
}

/**
 * POST /api/v1/bookings/:id/cancel
 *
 * Cancels a booking as the tenant. The refund amount is computed from the
 * configured refund policy, the escrow is settled accordingly, and both the
 * tenant and host are notified. Only the tenant may cancel.
 */
export async function cancelBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.cancelBooking(req.params.id, authUser.id, new Date(), authUser.role);

  if (!result.success) {
    const statusCode =
      result.statusCode ??
      (result.error === 'Booking not found'
        ? 404
        : result.error?.startsWith('Forbidden')
          ? 403
          : result.error === 'Booking is already cancelled' ||
              result.error === 'Cannot cancel a completed booking' ||
              result.error === 'Cannot cancel a disputed booking. Resolve the dispute first.'
            ? 409
            : 400);

    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function confirmBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.confirmBooking(req.params.id, authUser.id, authUser.role);

  if (!result.success) {
    const statusCode = result.statusCode ?? (result.error?.startsWith('Forbidden') ? 403 : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/complete
 *
 * Marks a Confirmed booking as Completed.
 * Only the booking tenant may call this endpoint.
 */
export async function completeBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await bookingService.completeBooking(req.params.id, authUser.id, authUser.role);

  if (!result.success) {
    const statusCode = result.statusCode ??
      (result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/dispute
 *
 * Opens a dispute on a Confirmed booking.
 * Only the booking tenant may call this endpoint.
 * Optional body: { reason: string }
 */
export async function disputeBooking(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;
  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
  const result = await bookingService.disputeBooking(req.params.id, authUser.id, reason);

  if (!result.success) {
    const statusCode =
      result.error?.startsWith('Forbidden') ? 403
      : result.error === 'Booking not found'  ? 404
      : 400;
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function updateBooking(req: Request, res: Response): Promise<void> {
  const result = await bookingService.updateBooking(req.params.id, req.body);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function deleteBooking(req: Request, res: Response): Promise<void> {
  const result = await bookingService.deleteBooking(req.params.id);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(204).send();
}

/**
 * GET /api/v1/bookings/:id/calendar.ics
 *
 * Returns a downloadable .ics file for the booking.
 * Only the booking's tenant is allowed to fetch it.
 */
export async function getBookingCalendar(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;

  const bookingResult = await bookingService.getBookingById(req.params.id);
  if (!bookingResult.success || !bookingResult.data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const booking = bookingResult.data;

  // Authorization: only the tenant may download their own calendar event
  if (!authUser || authUser.id !== booking.tenant_id) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  if (!booking.check_in || !booking.check_out) {
    res.status(422).json({ error: 'Booking is missing date information' });
    return;
  }

  // Fetch property details for location and title
  let propertyTitle = 'Rental Stay';
  let propertyLocation = '';
  if (booking.property_id) {
    const propResult = await getPropertyById(booking.property_id);
    if (propResult.success && propResult.data) {
      const p = propResult.data;
      propertyTitle = p.title ?? propertyTitle;
      const parts = [p.address, p.city, p.country].filter(Boolean);
      propertyLocation = parts.join(', ');
    }
  }

  const description = [
    `Booking ID: ${booking.id}`,
    `Guests: ${booking.guest_count ?? 1}`,
    `Total: ${booking.total_price ?? ''} USDC`,
    `Status: ${booking.status ?? ''}`,
  ]
    .filter(Boolean)
    .join('\\n');

  const ics = generateIcs({
    uid: `booking-${booking.id}@rentars.app`,
    summary: `Stay at ${propertyTitle}`,
    description,
    location: propertyLocation,
    dtStart: booking.check_in,
    dtEnd: booking.check_out,
    created: booking.created_at,
  });

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="booking-${booking.id}.ics"`);
  res.send(ics);
}

/**
 * GET /api/v1/bookings/:id/receipt.pdf
 *
 * Generates and streams a PDF receipt for the booking.
 * Only the booking's tenant or the property's host may download it.
 */
export async function getBookingReceipt(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string } }).user;

  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const bookingResult = await bookingService.getBookingById(req.params.id);
  if (!bookingResult.success || !bookingResult.data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const booking = bookingResult.data;

  // Fetch property to check host ownership
  let hostOwnerId: string | undefined;
  if (booking.property_id) {
    const propResult = await getPropertyById(booking.property_id);
    if (propResult.success && propResult.data) {
      hostOwnerId = propResult.data.owner_id;
    }
  }

  // Authorisation: tenant or host only
  const isTenant = authUser.id === booking.tenant_id;
  const isHost = !!hostOwnerId && authUser.id === hostOwnerId;

  if (!isTenant && !isHost) {
    res.status(403).json({ error: 'Forbidden: only the tenant or host may download this receipt' });
    return;
  }

  // Only allow receipts for completed/confirmed bookings
  const receiptableStatuses = ['Confirmed', 'Completed', 'confirmed', 'completed'];
  if (!booking.status || !receiptableStatuses.includes(booking.status)) {
    res.status(422).json({ error: 'Receipt is only available for confirmed or completed bookings' });
    return;
  }

  const receiptResult = await fetchReceiptData(req.params.id);
  if (!receiptResult.success || !receiptResult.data) {
    res.status(500).json({ error: receiptResult.error ?? 'Failed to fetch receipt data' });
    return;
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = generateReceiptPdf(receiptResult.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate PDF receipt' });
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="receipt-${booking.id}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.send(pdfBuffer);
}

/**
 * POST /api/v1/bookings/:id/dispute
 *
 * Raise a dispute on a booking. Only the tenant or host may raise a dispute.
 */
export async function raiseDispute(req: Request, res: Response): Promise<void> {
  const userId = (req as Request & { user?: { id: string } }).user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { reason, details } = req.body as { reason: string; details?: string };

  const result = await bookingService.raiseDispute(req.params.id, userId, reason, details);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/bookings/:id/dispute/resolve
 *
 * Resolve a dispute on a booking. Only admins/moderators may resolve disputes.
 */
export async function resolveDispute(req: Request, res: Response): Promise<void> {
  const authUser = (req as Request & { user?: { id: string; role?: string } }).user;

  if (!authUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { resolution, admin_notes } = req.body as {
    resolution: 'refund_tenant' | 'release_to_host';
    admin_notes?: string;
  };

  const result = await bookingService.resolveDispute(
    req.params.id,
    authUser.id,
    resolution,
    admin_notes,
    authUser.role
  );

  if (!result.success) {
    const statusCode = result.statusCode ?? (result.error?.startsWith('Forbidden') ? 403 : 400);
    res.status(statusCode).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/bookings/:id/refund-preview
 *
 * Shows the refund calculation from the booking-time policy snapshot *before*
 * the tenant confirms cancellation.  Does not modify any state. (#769)
 *
 * Returns: { tier, refundPct, refundAmount, totalPrice, hoursUntilCheckIn, policy }
 */
export async function getRefundPreviewHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Load the booking to get check_in
  const bookingResult = await bookingService.getBookingById(req.params.id);
  if (!bookingResult.success || !bookingResult.data) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const booking = bookingResult.data;

  // Only the tenant or admin can preview a refund
  if (booking.tenant_id !== userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  if (!booking.check_in) {
    res.status(422).json({ error: 'Booking is missing check-in date' });
    return;
  }

  const result = await getRefundPreview(req.params.id, booking.check_in, new Date());
  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error ?? 'Failed to compute refund preview' });
    return;
  }

  res.json({
    tier: result.data.tier,
    refundPct: result.data.refundPct,
    refundAmount: result.data.refundAmount,
    totalPrice: result.data.totalPrice,
    hoursUntilCheckIn: result.data.hoursUntilCheckIn,
    policy: result.data.policy,
    snapshotId: result.data.snapshotId,
  });
}

/**
 * GET /api/v1/bookings/:id/refund
 *
 * Returns the current refund request status for a booking. (#769)
 * Settlement states: requested, submitted, confirmed, failed, manual_review.
 */
export async function getRefundStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await getRefundRequestByBooking(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  if (!result.data) {
    res.status(404).json({ error: 'No refund request found for this booking' });
    return;
  }

  const refund = result.data;

  // Only the tenant, host, or admin can view the refund status
  if (refund.tenant_id !== userId && refund.host_id !== userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  res.json({
    id: refund.id,
    bookingId: refund.booking_id,
    status: refund.status,
    refundAmount: refund.refund_amount,
    refundTier: refund.refund_tier,
    refundPolicyPct: refund.refund_policy_pct,
    currency: refund.currency,
    txHash: refund.tx_hash,
    errorMessage: refund.error_message,
    attemptCount: refund.attempt_count,
    createdAt: refund.created_at,
    updatedAt: refund.updated_at,
  });
}
