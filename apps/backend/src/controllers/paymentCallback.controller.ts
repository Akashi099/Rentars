/**
 * Payment callback controller (#610).
 *
 * Receives POST webhooks from TrustlessWork / Stellar escrow providers.
 * Raw request bytes are read before Express JSON-parsing so the HMAC is
 * computed over the exact wire bytes.
 *
 * Route:  POST /api/v1/payments/callback
 * Header: X-TrustlessWork-Signature: <hmac-sha256-hex>
 */

import type { Request, Response } from 'express';
import {
  processProviderCallback,
  buildCallbackResponse,
} from '@/services/paymentCallback.service.js';

/**
 * Extract a correlation identifier from request headers or the parsed payload.
 * Only non-secret identifiers are considered; values are trimmed and length
 * bounded so user-supplied data cannot pollute logs or responses.
 */
function extractCorrelationId(
  req: Request,
  payload: unknown,
): string | undefined {
  const headerValue =
    (req.headers['x-correlation-id'] as string | undefined) ??
    (req.headers['x-request-id'] as string | undefined);

  const body = (payload ?? {}) as Record<string, unknown>;
  const bodyValue =
    typeof body.correlationId === 'string'
      ? body.correlationId
      : typeof body.correlation_id === 'string'
        ? body.correlation_id
        : undefined;

  const candidate = (headerValue ?? bodyValue)?.trim();
  if (!candidate) return undefined;
  return candidate.slice(0, 128);
}

function extractBookingId(req: Request, payload: unknown): string | undefined {
  const body = (payload ?? {}) as Record<string, unknown>;
  const value =
    (req.headers['x-booking-id'] as string | undefined) ??
    (typeof body.bookingId === 'string' ? body.bookingId : undefined) ??
    (typeof body.booking_id === 'string' ? body.booking_id : undefined);
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function extractOperationId(req: Request, payload: unknown): string | undefined {
  const body = (payload ?? {}) as Record<string, unknown>;
  const value =
    (req.headers['x-operation-id'] as string | undefined) ??
    (typeof body.operationId === 'string' ? body.operationId : undefined) ??
    (typeof body.operation_id === 'string' ? body.operation_id : undefined);
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

/**
 * POST /api/v1/payments/callback
 *
 * Expects the raw body to be stored on `req.rawBody` by the body-parser
 * middleware configured in the router (see payment.routes.ts).
 *
 * Never exposes internal error messages in the response.
 */
export async function handlePaymentCallback(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const signature = req.headers['x-trustlesswork-signature'] as string | undefined;

  const webhookSecret = process.env.TRUSTLESS_WORK_WEBHOOK_SECRET ?? '';
  const expectedProviderId = process.env.TRUSTLESS_WORK_PROVIDER_ID ?? '';

  if (!webhookSecret) {
    // Misconfiguration — fail open-safe: reject all callbacks
    res.status(500).json({ status: 'error', message: 'Webhook secret not configured' });
    return;
  }

  const correlationId = extractCorrelationId(req, req.body);
  const bookingId = extractBookingId(req, req.body);
  const operationId = extractOperationId(req, req.body);

  const result = await processProviderCallback(
    rawBody,
    signature,
    req.body,
    webhookSecret,
    expectedProviderId,
    { correlationId, bookingId, operationId },
  );

  const responseBody = buildCallbackResponse(result.data!);
  if (correlationId) {
    responseBody.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
  }
  res.status(result.statusCode ?? (result.success ? 200 : 400)).json(responseBody);
}
