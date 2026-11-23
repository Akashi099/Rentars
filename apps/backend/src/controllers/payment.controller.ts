/**
 * Payment controller — handles USDC payment submission, status polling, retry,
 * and quote generation (#768 — amount and currency integrity).
 *
 * Amount integrity flow:
 *   1. Client requests a quote: GET /api/v1/payments/quote?bookingId=...
 *   2. Server computes the total server-side in stroops and signs it with a
 *      quote hash (HMAC-SHA256 over bookingId + amount + currency + expiry).
 *   3. Client submits the signed quote: POST /api/v1/payments/submit
 *   4. Server verifies the quote hash before creating the payment intent so
 *      the client cannot substitute a lower amount.
 *   5. On-chain settlement amounts are compared during reconciliation; any
 *      mismatch enters `under_review` without marking the booking paid.
 */

import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  createPaymentIntent,
  getPaymentStatus,
  updatePaymentStatus,
  getPaymentTimeline,
} from '@/services/payment.service.js';
import {
  submitTransaction,
  confirmTransaction,
  retryTransaction,
  validateSignedPaymentTransaction,
  getActiveNetwork,
  getNetworkPassphrase,
} from '@/services/stellar.service.js';
import {
  validatePaymentAmount,
  usdcToStroops,
  buildAmountBreakdown,
  signQuote,
  verifyQuote,
  type SupportedCurrency,
} from '@/utils/payment.utils.js';
import { supabase } from '@/config/supabase.js';
import { randomUUID } from 'node:crypto';

// ─── Correlation context (#993) ────────────────────────────────────────────────

/**
 * Correlation identifiers propagated through API responses, service logs,
 * queue records, and provider calls. Only non-secret IDs are exposed.
 */
interface CorrelationContext {
  correlationId: string;
  bookingId?: string;
  operationId?: string;
}

/**
 * Reads the inbound correlation id (set by the correlation middleware) or
 * generates a new one. The value is echoed back on every response so an
 * operator can trace a user-visible failure through backend and worker events.
 */
function resolveCorrelation(req: AuthRequest, bookingId?: string, operationId?: string): CorrelationContext {
  const inbound = (req as AuthRequest & { correlationId?: string }).correlationId;
  const correlationId =
    typeof inbound === 'string' && inbound.trim() ? inbound.trim() : randomUUID();
  return { correlationId, bookingId, operationId };
}

/** Attaches correlation headers so clients/operators can reference the request. */
function applyCorrelationHeaders(res: Response, ctx: CorrelationContext): void {
  res.setHeader('X-Correlation-Id', ctx.correlationId);
  if (ctx.bookingId) res.setHeader('X-Booking-Id', ctx.bookingId);
  if (ctx.operationId) res.setHeader('X-Operation-Id', ctx.operationId);
}

/** Builds an error body that always carries the correlation context. */
function correlatedError(
  ctx: CorrelationContext,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    error: {
      code,
      message,
      correlationId: ctx.correlationId,
      bookingId: ctx.bookingId,
      operationId: ctx.operationId,
      ...extra,
    },
  };
}

// ─── Quote generation ──────────────────────────────────────────────────────────

const QUOTE_EXPIRY_MINUTES = 10;

const quoteQuerySchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
});

/**
 * GET /api/v1/payments/quote?bookingId=...
 *
 * Computes the payment amount server-side and returns a signed quote that the
 * client must submit back with the payment.  The quote hash binds the amount
 * to the booking so the client cannot substitute a lower value.
 *
 * Returns: { bookingId, amountStroops, amountDisplay, currency, quoteHash, expiresAt, quoteVersion }
 */
export async function getPaymentQuote(req: AuthRequest, res: Response): Promise<void> {
  const tenantId = req.userId;
  if (!tenantId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = quoteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { bookingId } = parsed.data;
  const ctx = resolveCorrelation(req, bookingId);
  applyCorrelationHeaders(res, ctx);

  // Booking total_price is the server-computed, persisted price agreed at
  // booking time. Repricing here could change a quote after policy updates.
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, total_price, tenant_id, status')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }

  const bookingRow = booking as {
    id: string;
    total_price: number | string;
    tenant_id: string;
    status: string;
  };

  // Verify the caller owns this booking
  if (bookingRow.tenant_id !== tenantId) {
    res.status(403).json({ error: 'Forbidden: only the booking tenant can request a quote' });
    return;
  }

  if (bookingRow.status.toLowerCase() !== 'pending') {
    res.status(409).json({ error: 'Only pending bookings can be paid' });
    return;
  }

  let amountStroops: bigint;
  try {
    amountStroops = usdcToStroops(String(bookingRow.total_price));
  } catch (err) {
    res.status(422).json({
      error: err instanceof Error ? err.message : 'Booking amount has unsupported precision',
    });
    return;
  }
  const currency: SupportedCurrency = 'USDC';

  // Generate a signed quote with expiry
  const expiresAt = new Date(Date.now() + QUOTE_EXPIRY_MINUTES * 60 * 1000).toISOString();
  const quoteHash = signQuote(bookingId, amountStroops, currency, expiresAt);

  const breakdown = buildAmountBreakdown(amountStroops, currency);

  // Conversion details are disclosed so support and users can audit the quote
  // (#950). USDC is the settlement currency, so the rate is 1:1 and no
  // conversion rounding is applied; the fields are still exposed so the
  // contract is stable if a non-1:1 currency is ever added.
  const rateTimestamp = new Date().toISOString();

  res.json({
    bookingId,
    amountStroops: amountStroops.toString(),
    amountDisplay: breakdown.amountDisplay,
    currency,
    quoteHash,
    expiresAt,
    quoteVersion: '1',
    // #950 — precision and conversion disclosure
    precision: {
      currencyDecimals: 7, // USDC on Stellar uses 7 decimal places (stroops)
      displayDecimals: 2,
      minorUnit: 'stroop',
    },
    conversion: {
      sourceCurrency: currency,
      targetCurrency: currency,
      rate: '1',
      rateSource: 'fixed:usdc-par',
      rateTimestamp,
      roundingMode: 'half-up',
      roundingApplied: false,
    },
  });
}

// ─── Payment submission ─────────────────────────────────────────────────────────

const submitSchema = z.object({
  bookingId: z.string().uuid('bookingId must be a valid UUID'),
  signedXdr: z.string().min(1, 'signedXdr is required'),
  amountStroops: z.string()
    .regex(/^\d+$/, 'amountStroops must be a non-negative integer string (stroops)'),
  currency: z.enum(['USDC']),
  quoteHash: z.string().min(1, 'quoteHash is required'),
  expiresAt: z.string().datetime('expiresAt must be an ISO-8601 datetime'),
  // Network the wallet was configured for when it signed the transaction.
  // Required so the backend can reject a wallet/backend network mismatch
  // before the signed XDR is ever broadcast (#881).
  network: z.enum(['mainnet', 'testnet']),
  networkPassphrase: z.string().min(1, 'networkPassphrase is required'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Verifies that the wallet that produced the signature is on the same Stellar
 * network as the backend. A mismatch means the transaction is unusable (or
 * unsafe) on the active network, so it must never be signed off or accepted.
 */
function validateNetworkAgreement(
  walletNetwork: string,
  walletPassphrase: string,
): { ok: true } | { ok: false; message: string } {
  const activeNetwork = getActiveNetwork();
  const activePassphrase = getNetworkPassphrase();

  if (walletNetwork !== activeNetwork) {
    return {
      ok: false,
      message: `Wallet is configured for ${walletNetwork} but the backend is on ${activeNetwork}. Switch your wallet network and request a new quote.`,
    };
  }

  if (walletPassphrase !== activePassphrase) {
    return {
      ok: false,
      message: 'Wallet network passphrase does not match the active Stellar network. Switch your wallet network and request a new quote.',
    };
  }

  return { ok: true };
}

/**
 * POST /api/v1/payments/submit
 *
 * Creates a payment intent, submits the signed XDR to Stellar, and begins
 * async confirmation polling (fire-and-forget — client polls for status).
 *
 * Body: { bookingId, signedXdr, amountStroops, currency, quoteHash, expiresAt, metadata? }
 * Returns: { paymentId, status }
 *
 * Error codes:
 *   400 VALIDATION_ERROR          — malformed request body
 *   422 NETWORK_MISMATCH          — wallet and backend are on different networks
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

  const {
    bookingId,
    signedXdr,
    amountStroops,
    currency,
    quoteHash,
    expiresAt,
    network,
    networkPassphrase,
    metadata,
  } = parsed.data;
  const tenantId = req.userId!;

  // ── 0. Establish correlation context (#993) ────────────────────────────────
  // The operation key is derived from the booking + quote so retries of the
  // same submission map to the same operation record.
  const operationId = `pay:${bookingId}:${quoteHash.slice(0, 16)}`;
  const ctx = resolveCorrelation(req, bookingId, operationId);
  applyCorrelationHeaders(res, ctx);

  // ── 1. Validate amount and currency (#768) ──────────────────────────────────
  const errors = validatePaymentAmount(amountStroops, currency);
  if (errors.length > 0) {
    res.status(422).json({
      error: {
        code: 'AMOUNT_VALIDATION_FAILED',
        details: errors.map((e) => ({ field: e.field, message: e.message })),
      },
    });
    return;
  }

  const stroops = BigInt(amountStroops);
  const supportedCurrency = currency as SupportedCurrency;

  // ── 2. Verify the quote hash before creating the payment intent (#768) ──────
  // This prevents the client from substituting a lower amount.
  const quoteValid = verifyQuote(quoteHash, bookingId, stroops, supportedCurrency, expiresAt);
  if (!quoteValid) {
    res.status(422).json({
      error: {
        code: 'QUOTE_VERIFICATION_FAILED',
        message: 'The quote hash is invalid, expired, or does not match the submitted amount. Request a new quote.',
      },
    });
    return;
  }

  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('id, tenant_id, total_price, status')
    .eq('id', bookingId)
    .single();

  if (bookingError || !booking) {
    res.status(404).json({ error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    return;
  }

  if (booking.tenant_id !== tenantId) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the booking tenant can pay' } });
    return;
  }

  if (String(booking.status).toLowerCase() !== 'pending') {
    res.status(409).json({ error: { code: 'BOOKING_NOT_PAYABLE', message: 'Only pending bookings can be paid' } });
    return;
  }

  let bookingAmountStroops: bigint;
  try {
    bookingAmountStroops = usdcToStroops(String(booking.total_price));
  } catch (err) {
    res.status(422).json({
      error: {
        code: 'BOOKING_AMOUNT_INVALID',
        message: err instanceof Error ? err.message : 'Booking amount has unsupported precision',
      },
    });
    return;
  }

  if (stroops !== bookingAmountStroops) {
    res.status(422).json({
      error: {
        code: 'BOOKING_AMOUNT_MISMATCH',
        message: 'The quote does not match the persisted booking total. Request a new quote.',
      },
    });
    return;
  }

  try {
    validateSignedPaymentTransaction(signedXdr, stroops);
  } catch (err) {
    res.status(422).json({
      error: {
        code: 'SIGNED_TRANSACTION_MISMATCH',
        message: err instanceof Error ? err.message : 'Signed transaction does not match the payment quote',
      },
    });
    return;
  }

  // ── 3. Create payment intent in 'pending' state ─────────────────────────────
  // Persist the network alongside the intent so the transaction state is
  // always tied to the correct booking, network, and account (#881).
  const payment = await createPaymentIntent({
    bookingId,
    tenantId,
    amountStroops: stroops,
    quoteHash,
    metadata,
    correlationId: ctx.correlationId,
    operationId: ctx.operationId,
  });

  // ── 4. Submit signed XDR to Stellar ─────────────────────────────────────────
  let txHash: string;
  try {
    const result = await submitTransaction(signedXdr);
    txHash = result.txHash;
    await updatePaymentStatus(payment.id, txHash, 'submitted');
    await recordSuccess('stellar_horizon');
  } catch (err) {
    await updatePaymentStatus(payment.id, null, 'failed');
    await recordFailure('stellar_horizon');
    res.status(502).json(
      correlatedError(
        ctx,
        'TX_SUBMIT_FAILED',
        err instanceof Error ? err.message : 'Transaction submission failed',
      ),
    );
    return;
  }

  // ── 5. Kick off async confirmation polling (does not block the response) ───
  // Correlation context is handed to the worker so deferred work retains it.
  confirmTransaction(payment.id, txHash, {
    correlationId: ctx.correlationId,
    bookingId,
    operationId: ctx.operationId,
  }).catch((err) => {
    console.error('[Payment] Confirmation polling failed', {
      paymentId: payment.id,
      correlationId: ctx.correlationId,
      bookingId,
      operationId: ctx.operationId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  res.status(202).json({
    paymentId: payment.id,
    status: 'submitted',
    txHash,
    correlationId: ctx.correlationId,
    bookingId,
    operationId: ctx.operationId,
  });
}

// ─── Status polling ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/payments/:id/status
 *
 * Returns the current payment status, tx hash, and amount breakdown.
 * Frontend polls this every 3 seconds while status is 'submitted'.
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  const id = req.params.id;
  if (typeof id !== 'string' || !id.trim()) {
    res.status(400).json({ error: { code: 'INVALID_PAYMENT_ID', message: 'Payment ID is required' } });
    return;
  }
  const payment = await getPaymentStatus(id);

  if (!payment) {
    const ctx = resolveCorrelation(req);
    applyCorrelationHeaders(res, ctx);
    res.status(404).json(correlatedError(ctx, 'NOT_FOUND', 'Payment not found'));
    return;
  }

  const ctx = resolveCorrelation(req, payment.booking_id, `pay:${payment.booking_id}:${payment.id}`);
  applyCorrelationHeaders(res, ctx);

  // Only the owning tenant or an admin may query
  if (payment.tenant_id !== req.userId && req.user?.role !== 'admin') {
    res.status(403).json(correlatedError(ctx, 'FORBIDDEN', 'Access denied'));
    return;
  }

  const breakdown = buildAmountBreakdown(payment.amount_stroops, payment.currency);

  // Distinguish submitted (broadcast, not yet on-ledger) from confirmed
  // (final ledger inclusion). 'pending'/'submitted' are non-final states.
  const status = String(payment.status).toLowerCase();
  const confirmed = status === 'confirmed';
  const pending = status === 'pending' || status === 'submitted';

  // Safe retry guidance: never encourage a blind re-broadcast while a
  // transaction may still be in flight or awaiting reconciliation (#881).
  let retryGuidance: 'none' | 'poll_status' | 'safe_to_retry' | 'do_not_retry_until_reconciled';
  if (confirmed) {
    retryGuidance = 'none';
  } else if (pending) {
    retryGuidance = 'poll_status';
  } else if (status === 'failed' && !payment.stellar_tx_hash) {
    retryGuidance = 'safe_to_retry';
  } else {
    retryGuidance = 'do_not_retry_until_reconciled';
  }

  res.json({
    paymentId: payment.id,
    bookingId: payment.booking_id,
    status: payment.status,
    confirmed,
    pending,
    txHash: payment.stellar_tx_hash,
    network: getActiveNetwork(),
    amountStroops: payment.amount_stroops.toString(),
    amountDisplay: breakdown.amountDisplay,
    currency: payment.currency,
    retryGuidance,
    updatedAt: payment.updated_at,
    correlationId: ctx.correlationId,
    operationId: ctx.operationId,
  });
}

// ─── Payment timeline (#951) ───────────────────────────────────────────────────

/**
 * GET /api/v1/payments/booking/:bookingId/timeline
 *
 * Returns a privacy-safe, ordered payment timeline for a booking.  Visible to
 * the booking tenant and the booking host (and admins).  Fields are filtered by
 * role so neither party sees the other's private identifiers.
 *
 * The timeline is derived from the canonical payment ledger; provider
 * processing states are distinguished from final ledger confirmation so the UI
 * never shows a premature success.
 *
 * Returns: { bookingId, terminal, currentStatus, steps: [{ key, label, status, timestamp, detail? }] }
 */
export async function getTimeline(req: AuthRequest, res: Response): Promise<void> {
  const bookingId = req.params.bookingId;
  if (typeof bookingId !== 'string' || !bookingId.trim()) {
    res.status(400).json({ error: { code: 'INVALID_BOOKING_ID', message: 'Booking ID is required' } });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, tenant_id, host_id')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    res.status(404).json({ error: { code: 'BOOKING_NOT_FOUND', message: 'Booking not found' } });
    return;
  }

  const bookingRow = booking as { id: string; tenant_id: string; host_id: string | null };

  const isAdmin = req.user?.role === 'admin';
  const isTenant = bookingRow.tenant_id === userId;
  const isHost = bookingRow.host_id === userId;

  if (!isAdmin && !isTenant && !isHost) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
    return;
  }

  const role: 'tenant' | 'host' | 'admin' = isAdmin ? 'admin' : isTenant ? 'tenant' : 'host';

  const timeline = await getPaymentTimeline(bookingId);

  // Role-based field filtering: only expose fields each participant may see.
  const steps = timeline.steps.map((step) => {
    const base = {
      key: step.key,
      label: step.label,
      status: step.status,
      timestamp: step.timestamp,
      // Distinguish provider processing from final ledger confirmation.
      phase: step.phase,
    };
    if (role === 'admin') {
      return { ...base, detail: step.detail, txHash: step.txHash };
    }
    if (role === 'tenant') {
      return { ...base, detail: step.tenantDetail ?? step.detail };
    }
    // host: never expose the tenant's tx hash or internal detail
    return { ...base, detail: step.hostDetail ?? null };
  });

  res.json({
    bookingId,
    role,
    terminal: timeline.terminal,
    currentStatus: timeline.currentStatus,
    steps,
  });
}

// ─── Retry ─────────────────────────────────────────────────────────────────────

const retrySchema = z.object({
  signedXdr: z.string().optional(),
});

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
  const id = req.params.id;
  if (typeof id !== 'string' || !id.trim()) {
    res.status(400).json({ error: { code: 'INVALID_PAYMENT_ID', message: 'Payment ID is required' } });
    return;
  }

  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const payment = await getPaymentStatus(id);
  if (!payment) {
    const ctx = resolveCorrelation(req);
    applyCorrelationHeaders(res, ctx);
    res.status(404).json(correlatedError(ctx, 'NOT_FOUND', 'Payment not found'));
    return;
  }

  // Retries reuse the original operation key so idempotency records and
  // worker events stay tied to the same booking + operation (#949, #993).
  const ctx = resolveCorrelation(req, payment.booking_id, `pay:${payment.booking_id}:${payment.id}`);
  applyCorrelationHeaders(res, ctx);

  if (payment.tenant_id !== req.userId) {
    res.status(403).json(correlatedError(ctx, 'FORBIDDEN', 'Access denied'));
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

  // ── Guard against blind re-broadcast ───────────────────────────────────────
  // If a txHash already exists the transaction may still be in flight or
  // awaiting reconciliation. Re-polling is safe; re-submitting is not.
  if (payment.stellar_tx_hash && parsed.data.signedXdr) {
    res.status(409).json({
      error: {
        code: 'RETRY_NOT_SAFE',
        message: 'A transaction has already been broadcast for this payment. It will be reconciled rather than re-submitted.',
        retryGuidance: 'do_not_retry_until_reconciled',
        txHash: payment.stellar_tx_hash,
      },
    });
    return;
  }

  try {
    const result = await retryTransaction(id, parsed.data.signedXdr, {
      correlationId: ctx.correlationId,
      bookingId: payment.booking_id,
      operationId: ctx.operationId,
    });
    res.json({
      paymentId: id,
      txHash: result.txHash,
      status: result.status,
      correlationId: ctx.correlationId,
      bookingId: payment.booking_id,
      operationId: ctx.operationId,
    });
  } catch (err) {
    res.status(422).json(
      correlatedError(ctx, 'RETRY_FAILED', err instanceof Error ? err.message : 'Retry failed'),
    );
  }
}
