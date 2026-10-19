/**
 * Payment controller — handles USDC payment submission, status polling, and retry.
 * No blockchain logic lives here; all Stellar calls go through stellar.service.ts.
 *
 * Protections added (closes #774):
 *   - Per-booking and per-actor attempt limits (paymentAttemptLimiter.service)
 *   - Provider circuit breaker (circuitBreaker.service)
 *   Retries count against both limits.  In-flight confirmTransaction() polling
 *   is never blocked by either guard.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  createPaymentIntent,
  getPaymentStatus,
  updatePaymentStatus,
} from '@/services/payment.service.js';
import {
  submitTransaction,
  confirmTransaction,
  retryTransaction,
} from '@/services/stellar.service.js';
import {
  checkCircuit,
  recordSuccess,
  recordFailure,
  PaymentCircuitOpenError,
} from '@/services/circuitBreaker.service.js';
import { checkAndIncrementAttempts } from '@/services/paymentAttemptLimiter.service.js';

/**
 * Convert a USDC decimal amount (e.g. 25.50) to stroops (integer bigint).
 * 1 USDC = 10_000_000 stroops (7 decimal places).
 * We multiply by 10_000_000 and round to handle floating-point imprecision.
 */
function usdcToStroops(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10_000_000));
}

const submitSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  signedXdr: z.string().min(1, 'signedXdr is required'),
  /**
   * Amount expressed in USDC (decimal). Converted to stroops (bigint) before
   * creating the payment intent so the canonical amount unit is always stroops.
   * Example: amountUsdc: 25.5  →  amountStroops: 255_000_000n
   */
  amountUsdc: z.number().positive('amountUsdc must be positive'),
  metadata: z.record(z.unknown()).optional(),
});

const retrySchema = z.object({
  signedXdr: z.string().optional(),
});

/**
 * POST /api/v1/payments/submit
 *
 * Creates a payment intent, submits the signed XDR to Stellar, and begins
 * async confirmation polling (fire-and-forget — client polls for status).
 *
 * Body: { bookingId, signedXdr, amountUsdc, metadata? }
 * Returns: { paymentId, status }
 *
 * Error codes:
 *   400 VALIDATION_ERROR          — malformed request body
 *   429 PAYMENT_ATTEMPT_LIMIT_EXCEEDED — booking or actor attempt limit hit
 *   503 PAYMENT_CIRCUIT_OPEN      — provider unavailable (circuit tripped)
 *   502 TX_SUBMIT_FAILED          — Stellar submission error
 */
export async function submitPayment(req: AuthRequest, res: Response): Promise<void> {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { bookingId, signedXdr, amountUsdc, metadata } = parsed.data;
  const tenantId = req.userId!;

  // ── 1. Attempt limiter ─────────────────────────────────────────────────────
  const attemptResult = await checkAndIncrementAttempts(bookingId, tenantId);
  if (!attemptResult.allowed) {
    res.status(429).json({
      error: {
        code: 'PAYMENT_ATTEMPT_LIMIT_EXCEEDED',
        message: 'Too many payment attempts. Please try again later.',
        retryAfterSeconds: attemptResult.retryAfterSeconds ?? 3600,
      },
    });
    return;
  }

  // ── 2. Circuit breaker — blocks only NEW submissions ───────────────────────
  try {
    await checkCircuit('stellar_horizon');
  } catch (err) {
    if (err instanceof PaymentCircuitOpenError) {
      res.status(503).json({
        error: {
          code: 'PAYMENT_CIRCUIT_OPEN',
          message: 'Payment processing is temporarily unavailable. Please try again in a few minutes.',
          retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000),
        },
      });
      return;
    }
    throw err;
  }

  // ── 3. Create payment intent in 'pending' state ────────────────────────────
  const amountStroops = usdcToStroops(amountUsdc);
  const payment = await createPaymentIntent({ bookingId, tenantId, amountStroops, metadata });

  // ── 4. Submit signed XDR to Stellar ───────────────────────────────────────
  let txHash: string;
  try {
    const result = await submitTransaction(signedXdr);
    txHash = result.txHash;
    await updatePaymentStatus(payment.id, txHash, 'submitted');
    await recordSuccess('stellar_horizon');
  } catch (err) {
    await updatePaymentStatus(payment.id, null, 'failed');
    await recordFailure('stellar_horizon');
    res.status(502).json({
      error: {
        code: 'TX_SUBMIT_FAILED',
        message: err instanceof Error ? err.message : 'Transaction submission failed',
      },
    });
    return;
  }

  // ── 5. Kick off async confirmation polling (does not block the response) ───
  // NOTE: confirmTransaction is in-flight polling and must NOT call checkCircuit.
  confirmTransaction(payment.id, txHash).catch((err) => {
    console.error('[Payment] Confirmation polling failed for', payment.id, err);
  });

  res.status(202).json({ paymentId: payment.id, status: 'submitted', txHash });
}

/**
 * GET /api/v1/payments/:id/status
 *
 * Returns the current payment status and tx hash.
 * Frontend polls this every 3 seconds while status is 'submitted'.
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;
  const payment = await getPaymentStatus(id);

  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  // Only the owning tenant or an admin may query
  if (payment.tenant_id !== req.userId && req.user?.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  res.json({
    paymentId: payment.id,
    bookingId: payment.booking_id,
    status: payment.status,
    txHash: payment.stellar_tx_hash,
    amountStroops: payment.amount_stroops.toString(),
    amountUsdc: Number(payment.amount_stroops) / 10_000_000,
    updatedAt: payment.updated_at,
  });
}

/**
 * POST /api/v1/payments/:id/retry
 *
 * Retries a failed or timed-out payment safely.
 * If the payment already has a txHash, it re-polls instead of re-submitting.
 *
 * Retries count against the attempt limits and are subject to circuit
 * breaker checks exactly like original submissions.
 *
 * Body: { signedXdr? } — only required if no txHash exists on the payment.
 *
 * Error codes:
 *   400 VALIDATION_ERROR          — malformed request body
 *   404 NOT_FOUND                 — payment not found
 *   403 FORBIDDEN                 — caller is not the owning tenant
 *   429 PAYMENT_ATTEMPT_LIMIT_EXCEEDED — attempt limit hit
 *   503 PAYMENT_CIRCUIT_OPEN      — provider unavailable
 *   422 RETRY_FAILED              — retry logic failed
 */
export async function retryPayment(req: AuthRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const payment = await getPaymentStatus(id);
  if (!payment) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    return;
  }

  if (payment.tenant_id !== req.userId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  const tenantId = req.userId!;

  // ── Attempt limiter ────────────────────────────────────────────────────────
  const attemptResult = await checkAndIncrementAttempts(payment.booking_id, tenantId);
  if (!attemptResult.allowed) {
    res.status(429).json({
      error: {
        code: 'PAYMENT_ATTEMPT_LIMIT_EXCEEDED',
        message: 'Too many payment attempts. Please try again later.',
        retryAfterSeconds: attemptResult.retryAfterSeconds ?? 3600,
      },
    });
    return;
  }

  // ── Circuit breaker ────────────────────────────────────────────────────────
  try {
    await checkCircuit('stellar_horizon');
  } catch (err) {
    if (err instanceof PaymentCircuitOpenError) {
      res.status(503).json({
        error: {
          code: 'PAYMENT_CIRCUIT_OPEN',
          message: 'Payment processing is temporarily unavailable. Please try again in a few minutes.',
          retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000),
        },
      });
      return;
    }
    throw err;
  }

  try {
    const result = await retryTransaction(id, parsed.data.signedXdr);
    res.json({ paymentId: id, txHash: result.txHash, status: result.status });
  } catch (err) {
    res.status(422).json({
      error: {
        code: 'RETRY_FAILED',
        message: err instanceof Error ? err.message : 'Retry failed',
      },
    });
  }
}
