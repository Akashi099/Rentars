import type { Request, Response } from 'express';
import {
  syncAllBookings,
  syncAllProperties,
  syncBookingFromChain,
  syncPropertyFromChain,
} from '@/services/sync.service.js';
import { getCorrelationContext } from '@/middleware/correlation.middleware.js';

export async function syncPropertyHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const context = getCorrelationContext(req);
  const result = await syncPropertyFromChain(id, context);

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: `Property ${id} synced successfully`,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}

export async function syncBookingHandler(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const context = getCorrelationContext(req, { bookingId: id });
  const result = await syncBookingFromChain(id, context);

  if (!result.success) {
    res.status(500).json({
      error: result.error,
      correlation_id: context.correlationId,
      booking_id: context.bookingId,
    });
    return;
  }
  res.json({
    message: `Booking ${id} synced successfully`,
    correlation_id: context.correlationId,
    booking_id: context.bookingId,
    operation_id: context.operationId,
  });
}

export async function syncAllPropertiesHandler(req: Request, res: Response): Promise<void> {
  const context = getCorrelationContext(req);
  const result = await syncAllProperties(context);

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: 'All properties synced',
    ...result.data,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}

export async function syncAllBookingsHandler(req: Request, res: Response): Promise<void> {
  const context = getCorrelationContext(req);
  const result = await syncAllBookings(context);

  if (!result.success) {
    res.status(500).json({ error: result.error, correlation_id: context.correlationId });
    return;
  }
  res.json({
    message: 'All bookings synced',
    ...result.data,
    correlation_id: context.correlationId,
    operation_id: context.operationId,
  });
}