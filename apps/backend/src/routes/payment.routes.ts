/**
 * Payment routes.
 *
 * Authenticated routes (tenant-facing):
 *   POST   /api/v1/payments/submit      — Submit signed XDR
 *   GET    /api/v1/payments/:id/status  — Poll status
 *   GET    /api/v1/payments/:id/timeline — Privacy-safe payment timeline
 *   POST   /api/v1/payments/:id/retry   — Retry failed payment
 *
 * Unauthenticated webhook (provider-facing, #610):
 *   POST   /api/v1/payments/callback    — Receive provider callbacks
 *
 * The callback route captures raw bytes before Express JSON-parses the body
 * so that HMAC signature verification operates on the exact wire content.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { json } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { bookingRateLimiter } from '@/middleware/rateLimiter.js';
import {
  getPaymentQuote,
  submitPayment,
  getStatus,
  getTimeline,
  retryPayment,
} from '@/controllers/payment.controller.js';
import { handlePaymentCallback } from '@/controllers/paymentCallback.controller.js';

const router = Router();

// ── Webhook (unauthenticated, raw-body capture) ───────────────────────────────

/**
 * Middleware: capture raw request body as a Buffer and attach to `req.rawBody`
 * before handing off to the JSON body-parser.  Required for HMAC verification.
 */
function captureRawBody(req: Request, _res: Response, next: NextFunction): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    (req as Request & { rawBody: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', next);
}

router.post(
  '/callback',
  captureRawBody,
  json(), // parse body after raw capture
  handlePaymentCallback,
);

// ── Authenticated tenant routes ───────────────────────────────────────────────

router.use(authenticate);

/**
 * GET /api/v1/payments/quote?bookingId=...
 * Return the server-computed, signed amount quote required for payment.
 */
router.get('/quote', getPaymentQuote);

/**
 * POST /api/v1/payments/submit
 * Submit a signed XDR to Stellar and create a tracked payment intent.
 */
router.post('/submit', bookingRateLimiter, submitPayment);

/**
 * GET /api/v1/payments/:id/status
 * Poll current payment status. Frontend polls every 3s while status=submitted.
 */
router.get('/:id/status', getStatus);

/**
 * GET /api/v1/payments/:id/timeline
 *
 * Return the canonical payment timeline for the booking associated with the
 * payment intent. Accessible only to the booking's tenant and host (role
 * checks are enforced in the controller); any other authenticated user gets
 * 403/404 without leaking existence.
 *
 * Response shape:
 *   {
 *     paymentId: string,
 *     bookingId: string,
 *     currentState: 'quote' | 'submitted' | 'processing' | 'confirmed'
 *                 | 'settled' | 'refunded' | 'failed',
 *     terminal: boolean,
 *     events: Array<{
 *       state: string,          // canonical ledger-derived state
 *       label: string,          // consistent user-facing label
 *       timestamp: string,      // ISO-8601, ledger time (not client time)
 *       source: 'provider' | 'ledger', // provider processing vs final ledger
 *       visibleTo: ('tenant' | 'host')[] // fields filtered per role
 *     }>
 *   }
 *
 * Terminal-state semantics: when `terminal` is true (settled, refunded or
 * failed) clients MUST stop polling/realtime updates. Provider-reported
 * states are never surfaced as success; only ledger-confirmed states
 * (`source: 'ledger'`) may indicate final settlement or refund.
 */
router.get('/:id/timeline', bookingRateLimiter, getTimeline);

/**
 * POST /api/v1/payments/:id/retry
 * Retry a failed or timed-out payment safely (double-spend protected).
 */
router.post('/:id/retry', bookingRateLimiter, retryPayment);

export default router;
