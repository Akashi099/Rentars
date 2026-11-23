/**
 * Payment callback verification service (#610).
 *
 * Defends against:
 *  - Forged signatures  — HMAC-SHA256 over raw request bytes
 *  - Replay attacks     — persisted event-ID ledger with TTL
 *  - Clock skew         — reject events older than MAX_CLOCK_SKEW_MS
 *  - Out-of-order       — tolerated; idempotency in state machine handles it
 *  - Cross-booking      — validate payload booking/amount against DB record
 *  - Unknown payloads   — quarantine via transitionPaymentStatus()
 *
 * Provider responses follow HTTP semantics:
 *  - 200 with { status: 'acknowledged' } on valid new event
 *  - 200 with { status: 'replayed' } on recognised duplicate
 *  - 400 on malformed payload
 *  - 401 on invalid / missing signature
 *  - 422 on semantic mismatch (wrong booking / amount)
 *
 * Internal error details are never surfaced to the provider to avoid
 * information leakage.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '@/config/supabase.js';
import { usdcToStroops } from '@/utils/payment.utils.js';
import {
  transitionPaymentStatus,
  mapProviderStatus,
  hashEventPayload,
  getPaymentByBookingId,
} from './payment.service.js';
import {
  reconcileEscrowOperation,
  type EscrowOperationType,
} from './escrowOperation.service.js';
import type { ServiceResponse } from './index.js';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum age of an incoming callback before it is rejected as stale. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000; // 5 minutes

/** How long event IDs are retained in the replay ledger. */
const REPLAY_TTL_HOURS = 24;

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Expected shape of a TrustlessWork / generic escrow callback body.
 * Unknown extra fields are stripped by Zod's .strict() equivalent via
 * passthrough — they are still hashed for the replay ledger.
 */
export const callbackBodySchema = z.object({
  /** Unique event ID issued by the provider. */
  eventId: z.string().min(1),
  /** ISO-8601 timestamp when the provider emitted this event. */
  timestamp: z.string().datetime(),
  /** Provider-specific status string — mapped via mapProviderStatus(). */
  status: z.string().min(1),
  /** UUID of the booking this event relates to. */
  bookingId: z.string().uuid(),
  /** Amount in USDC stroops (integer as string to survive JSON serialization). */
  amountStroops: z.string().regex(/^\d+$/, 'amountStroops must be a non-negative integer string'),
  /** Provider's account or API-key identifier — must match env config. */
  providerAccountId: z.string().min(1),
  /** Optional Stellar transaction hash associated with the event. */
  txHash: z.string().optional(),
  /** Optional escrow operation key this event settles (idempotency key). */
  operationKey: z.string().min(1).optional(),
  /** Optional escrow operation type this event settles. */
  operationType: z.enum(['create', 'release', 'refund']).optional(),
  /** Optional provider-side escrow reference. */
  providerReference: z.string().min(1).optional(),
  /** Optional correlation ID propagated from the originating request. */
  correlationId: z.string().min(1).optional(),
}).passthrough();

export type CallbackBody = z.infer<typeof callbackBodySchema>;

// ─── Verification result ──────────────────────────────────────────────────────

export type CallbackVerificationStatus =
  | 'acknowledged'
  | 'replayed'
  | 'invalid_signature'
  | 'invalid_timestamp'
  | 'invalid_payload'
  | 'mismatch'
  | 'quarantined';

export interface CallbackVerificationResult {
  status: CallbackVerificationStatus;
  /** HTTP status code to return to the provider. */
  httpStatus: number;
  /** Safe message to surface to the provider (no internals). */
  message: string;
}

// ─── Correlation context ──────────────────────────────────────────────────────

/**
 * Nonsecret correlation identifiers attached to every callback log line.
 * Never includes signatures, auth headers, wallet secrets or payload bodies.
 */
interface CallbackCorrelation {
  correlationId: string;
  bookingId: string;
  operationId?: string;
  operationKey?: string;
  eventId: string;
}

/**
 * Emit a structured, redacted log line for callback processing.
 * Only nonsecret identifiers and coarse statuses are included.
 */
function logCallback(
  level: 'info' | 'warn' | 'error',
  message: string,
  ctx: Partial<CallbackCorrelation> & Record<string, unknown>,
): void {
  const safe = {
    correlationId: ctx.correlationId ?? 'unknown',
    bookingId: ctx.bookingId ?? 'unknown',
    operationId: ctx.operationId ?? null,
    operationKey: ctx.operationKey ?? null,
    eventId: ctx.eventId ?? null,
    ...ctx,
  };
  const line = `[Callback] ${message} ${JSON.stringify(safe)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 over `rawBody` using `secret`.
 * Returns lowercase hex.
 */
function computeHmac(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Timing-safe comparison of two hex digest strings.
 * Prevents leaking secret length via early-exit timing.
 */
function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a.padEnd(64, '0').slice(0, 64), 'hex');
    const bufB = Buffer.from(b.padEnd(64, '0').slice(0, 64), 'hex');
    return timingSafeEqual(bufA, bufB) && a.length === b.length;
  } catch {
    return false;
  }
}

/**
 * Check whether `eventId` has already been processed (replay ledger).
 * Returns true when the event is a known replay.
 */
async function isReplay(eventId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - REPLAY_TTL_HOURS * 60 * 60 * 1_000).toISOString();
  const { data } = await supabase
    .from('payment_callback_events')
    .select('id')
    .eq('event_id', eventId)
    .gte('created_at', cutoff)
    .maybeSingle();
  return data !== null;
}

/**
 * Persist an event ID to the replay ledger.
 */
async function recordEvent(
  eventId: string,
  bookingId: string,
  eventHash: string,
  correlation?: { correlationId?: string; operationId?: string; operationKey?: string },
): Promise<void> {
  await supabase
    .from('payment_callback_events')
    .insert({
      event_id: eventId,
      booking_id: bookingId,
      event_hash: eventHash,
      correlation_id: correlation?.correlationId ?? null,
      operation_id: correlation?.operationId ?? null,
      operation_key: correlation?.operationKey ?? null,
      created_at: new Date().toISOString(),
    })
    .select(); // fire-and-forget but await to avoid unhandled rejections
}

/**
 * Reconcile an escrow operation referenced by a callback.
 *
 * When the callback carries an operation key/type, the operation state
 * machine is advanced from `pending`/`ambiguous` to a terminal state using
 * the provider's authoritative outcome. This is what allows a timed-out
 * submission to be resolved without a second external call.
 */
async function reconcileFromCallback(
  body: CallbackBody,
  canonicalStatus: string,
  ctx: CallbackCorrelation,
): Promise<void> {
  if (!body.operationKey || !body.operationType) return;

  try {
    const result = await reconcileEscrowOperation({
      bookingId: body.bookingId,
      operationKey: body.operationKey,
      operationType: body.operationType as EscrowOperationType,
      providerReference: body.providerReference ?? body.txHash ?? null,
      providerStatus: canonicalStatus,
      correlationId: ctx.correlationId,
    });

    if (!result.success) {
      logCallback('warn', 'escrow operation reconciliation failed', {
        ...ctx,
        error: result.error,
      });
      return;
    }

    logCallback('info', 'escrow operation reconciled', {
      ...ctx,
      operationId: result.data?.id,
      operationState: result.data?.state,
    });
  } catch (err) {
    logCallback('error', 'escrow operation reconciliation threw', {
      ...ctx,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

// ─── Main verifier ────────────────────────────────────────────────────────────

/**
 * Verify and process an incoming payment provider callback.
 *
 * @param rawBody          - Raw request body bytes (Buffer) for HMAC verification.
 * @param signatureHeader  - Value of the provider's signature header
 *                           (e.g. `X-TrustlessWork-Signature`).
 * @param parsedBody       - Already-parsed JSON from the request (Express req.body).
 * @param webhookSecret    - Shared HMAC secret configured in env (per-provider).
 * @param expectedProviderId - The provider account ID we expect in the payload.
 *
 * @returns CallbackVerificationResult — describes what to return to the provider.
 */
export async function verifyAndProcessCallback(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  parsedBody: unknown,
  webhookSecret: string,
  expectedProviderId: string,
): Promise<CallbackVerificationResult> {

  // ── 1. Signature presence ────────────────────────────────────────────────
  if (!signatureHeader) {
    return {
      status: 'invalid_signature',
      httpStatus: 401,
      message: 'Missing signature header',
    };
  }

  // ── 2. HMAC signature verification (constant time) ───────────────────────
  const expected = computeHmac(rawBody, webhookSecret);
  if (!safeCompare(signatureHeader, expected)) {
    return {
      status: 'invalid_signature',
      httpStatus: 401,
      message: 'Signature verification failed',
    };
  }

  // ── 3. Payload schema validation ─────────────────────────────────────────
  const parseResult = callbackBodySchema.safeParse(parsedBody);
  if (!parseResult.success) {
    return {
      status: 'invalid_payload',
      httpStatus: 400,
      message: 'Malformed callback payload',
    };
  }

  const body = parseResult.data;

  // Correlation context — nonsecret identifiers only.
  const ctx: CallbackCorrelation = {
    correlationId: body.correlationId ?? body.eventId,
    bookingId: body.bookingId,
    operationKey: body.operationKey,
    eventId: body.eventId,
  };

  // ── 4. Clock skew check ───────────────────────────────────────────────────
  const eventAge = Date.now() - new Date(body.timestamp).getTime();
  if (Math.abs(eventAge) > MAX_CLOCK_SKEW_MS) {
    logCallback('warn', 'event timestamp outside acceptable window', {
      ...ctx,
      eventAgeMs: eventAge,
    });
    return {
      status: 'invalid_timestamp',
      httpStatus: 400,
      message: 'Event timestamp outside acceptable window',
    };
  }

  // ── 5. Provider account identity check ───────────────────────────────────
  if (body.providerAccountId !== expectedProviderId) {
    // Potential cross-tenant injection; quarantine
    logCallback('error', 'provider account identity mismatch', {
      ...ctx,
      providerAccountId: body.providerAccountId,
    });
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Provider account identity mismatch',
    };
  }

  // ── 6. Replay detection ───────────────────────────────────────────────────
  const eventHash = hashEventPayload(body as unknown as Record<string, unknown>);

  if (await isReplay(body.eventId)) {
    logCallback('info', 'duplicate callback event ignored', ctx);
    return {
      status: 'replayed',
      httpStatus: 200,
      message: 'Event already processed',
    };
  }

  // ── 7. Load payment and cross-reference booking + amount ─────────────────
  const payment = await getPaymentByBookingId(body.bookingId);

  if (!payment) {
    // Booking not found — could be a test event or mis-routed webhook
    logCallback('warn', 'no payment found for booking', ctx);
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Booking not found',
    };
  }

  const incomingStroops = BigInt(body.amountStroops);
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('total_price')
    .eq('id', body.bookingId)
    .single();

  if (bookingError) {
    logCallback('error', 'failed to verify booking amount', {
      ...ctx,
      error: bookingError.message,
    });
    return {
      status: 'quarantined',
      httpStatus: 503,
      message: 'Booking verification is temporarily unavailable; retry the event',
    };
  }

  let bookingAmountStroops: bigint | null = null;
  if (booking) {
    try {
      bookingAmountStroops = usdcToStroops(String(booking.total_price));
    } catch {
      bookingAmountStroops = null;
    }
  }

  if (
    !booking ||
    bookingAmountStroops === null ||
    incomingStroops !== payment.amount_stroops ||
    payment.amount_stroops !== bookingAmountStroops
  ) {
    // Amount mismatch — quarantine; do NOT mark paid
    logCallback('error', 'amount mismatch or booking lookup failure', {
      ...ctx,
      providerStroops: incomingStroops.toString(),
      paymentStroops: payment.amount_stroops.toString(),
      bookingStroops: bookingAmountStroops?.toString() ?? 'unavailable',
    });
    // Transition to under_review so the discrepancy is auditable
    await transitionPaymentStatus(
      payment.id,
      'under_review',
      {
        ...body,
        _reason: 'amount_mismatch',
      } as unknown as Record<string, unknown>,
    );
    // Record in replay ledger to avoid re-processing
    await recordEvent(body.eventId, body.bookingId, eventHash, ctx);
    return {
      status: 'mismatch',
      httpStatus: 422,
      message: 'Amount mismatch — payment under review',
    };
  }

  // ── 8. Map provider status and apply transition ───────────────────────────
  const canonicalStatus = mapProviderStatus(body.status);

  const transitionResult = await transitionPaymentStatus(
    payment.id,
    canonicalStatus,
    body as unknown as Record<string, unknown>,
    body.txHash ?? null,
  );

  // Record in replay ledger regardless of transition outcome
  await recordEvent(body.eventId, body.bookingId, eventHash, ctx);

  if (!transitionResult.success) {
    logCallback('error', 'payment transition failed', {
      ...ctx,
      paymentId: payment.id,
      error: transitionResult.error,
    });
    // Still return 200 to the provider (we received it fine; our internal
    // state diverged, which is a separate alert path).
    return {
      status: 'quarantined',
      httpStatus: 200,
      message: 'Event received; payment under review',
    };
  }

  const transition = transitionResult.data;
  if (!transition) {
    logCallback('error', 'payment transition returned no data', {
      ...ctx,
      paymentId: payment.id,
    });
    return {
      status: 'quarantined',
      httpStatus: 200,
      message: 'Event received; payment under review',
    };
  }

  // ── 9. Reconcile any escrow operation this callback settles ───────────────
  // Runs after the payment transition so the operation state machine sees
  // the authoritative provider outcome. Duplicate callbacks are already
  // filtered by the replay ledger above, and reconciliation itself is
  // idempotent on the operation key.
  await reconcileFromCallback(body, canonicalStatus, ctx);

  const { replayed } = transition;

  if (transition.payment.status === 'under_review') {
    logCallback('warn', 'payment under review after callback', {
      ...ctx,
      paymentId: payment.id,
    });
    return {
      status: 'quarantined',
      httpStatus: 200,
      message: 'Event received; payment under review',
    };
  }

  logCallback('info', replayed ? 'duplicate callback acknowledged' : 'callback acknowledged', {
    ...ctx,
    paymentId: payment.id,
    canonicalStatus,
  });

  return {
    status: replayed ? 'replayed' : 'acknowledged',
    httpStatus: 200,
    message: replayed ? 'Event already processed' : 'Event acknowledged',
  };
}

// ─── HTTP handler helper ──────────────────────────────────────────────────────

/**
 * Convenience: build the provider-safe response body from a verification result.
 * Internal details are stripped.
 */
export function buildCallbackResponse(result: CallbackVerificationResult): {
  status: string;
  message: string;
} {
  return {
    status: result.status === 'acknowledged' || result.status === 'replayed'
      ? result.status
      : 'error',
    message: result.message,
  };
}

// ─── ServiceResponse wrapper ──────────────────────────────────────────────────

/**
 * Wraps verifyAndProcessCallback() to return a ServiceResponse for use in
 * controllers. Sets statusCode so the controller can call res.status().
 */
export async function processProviderCallback(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  parsedBody: unknown,
  webhookSecret: string,
  expectedProviderId: string,
): Promise<ServiceResponse<CallbackVerificationResult>> {
  const result = await verifyAndProcessCallback(
    rawBody,
    signatureHeader,
    parsedBody,
    webhookSecret,
    expectedProviderId,
  );

  return {
    success: result.httpStatus < 400,
    data: result,
    statusCode: result.httpStatus,
    error: result.httpStatus >= 400 ? result.message : undefined,
  };
}
