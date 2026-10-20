/**
 * Payment service — canonical state machine for USDC payment intents.
 *
 * State lifecycle (closes #609):
 *
 *   ┌─────────┐
 *   │ pending │  Payment intent created; no transaction submitted yet.
 *   └────┬────┘
 *        │ submitTransaction()
 *        ▼
 *   ┌───────────┐
 *   │ submitted │  Signed XDR delivered to Stellar Horizon; awaiting ledger.
 *   └─────┬─────┘
 *         ├─── confirmTransaction() → ┌───────────┐
 *         │                           │ confirmed │  Ledger sealed; escrow funded.
 *         │                           └───────────┘
 *         ├─── on-chain failure   → ┌────────┐
 *         │                         │ failed │  Terminal; no escrow.
 *         │                         └────────┘
 *         └─── 60 s timeout      → ┌───────────┐
 *                                  │ timed_out │  May be retried.
 *                                  └───────────┘
 *
 * Additional terminal states:
 *   refunded      — escrow cancelled, funds returned to tenant.
 *   under_review  — conflicting update quarantined for manual review.
 *
 * Rules enforced here:
 *  1. Transitions only advance through the allowed graph; regressive moves
 *     are rejected and quarantined as `under_review`.
 *  2. Each event carries a SHA-256 hash of its payload; duplicate hashes
 *     are idempotently replayed without re-applying side-effects.
 *  3. External provider IDs (escrow_id, stellar_tx_hash) are stored so
 *     every payment has a complete, auditable lifecycle.
 *  4. Unknown / unsupported statuses returned by external providers are
 *     quarantined rather than silently accepted.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';
import {
  type PaymentErrorCategory,
  type PaymentErrorContext,
  type PaymentNextAction,
  type PaymentErrorResponse,
  classifyPaymentError,
  buildPaymentErrorResponse,
  isResubmissionBlocked,
} from './paymentErrorTaxonomy.js';
import {
  checkCircuitBreaker,
  recordProviderOutcome,
  recordPaymentAttempt,
} from './paymentCircuitBreaker.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'timed_out'
  | 'refunded'
  | 'under_review';

/**
 * Allowed forward transitions in the payment state machine.
 * Any move not listed here is rejected and quarantined.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlyArray<PaymentStatus>>> = {
  pending:      ['submitted', 'failed'],
  submitted:    ['confirmed', 'failed', 'timed_out'],
  confirmed:    ['refunded'],
  failed:       [],                         // terminal
  timed_out:    ['submitted', 'failed'],    // retryable
  refunded:     [],                         // terminal
  under_review: ['pending', 'failed'],      // admin-only resolution
};

/**
 * External provider statuses mapped to canonical PaymentStatus.
 * Anything not listed is treated as unknown → under_review.
 */
const PROVIDER_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  // Stellar / Horizon
  SUCCESS:   'confirmed',
  FAILED:    'failed',
  NOT_FOUND: 'timed_out',
  // TrustlessWork escrow statuses
  funded:    'confirmed',
  released:  'refunded',
  cancelled: 'failed',
  disputed:  'under_review',
  created:   'pending',
};

export interface Payment {
  id: string;
  booking_id: string;
  tenant_id: string;
  /** Amount in USDC stroops (integer, 1 USDC = 10_000_000 stroops). */
  amount_stroops: bigint;
  /** Supported currency token — currently only USDC. */
  currency: 'USDC';
  stellar_tx_hash: string | null;
  /** TrustlessWork escrow contract ID, if applicable. */
  escrow_id: string | null;
  /** Quote reference hash signed at intent creation (for amount integrity). */
  quote_hash: string | null;
  status: PaymentStatus;
  /** Version counter incremented on every transition (optimistic concurrency). */
  version: number;
  /** SHA-256 of the last event payload that triggered a transition. */
  last_event_hash: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface CreatePaymentIntentParams {
  bookingId: string;
  tenantId: string;
  /** Amount in USDC stroops (integer). Use amountUsdcToStroops() to convert. */
  amountStroops: bigint;
  /** Quote hash produced by payment.utils.ts#hashQuote() and verified server-side. */
  quoteHash?: string;
  escrowId?: string;
  metadata?: Record<string, unknown>;
}

export interface TransitionResult {
  payment: Payment;
  /** True when the event was a duplicate (same hash) — no side-effects applied. */
  replayed: boolean;
}

/**
 * Structured failure returned by payment operations. Carries the error
 * category, a user-safe message, the current transaction status, the
 * preserved idempotency context, and the set of next actions that are safe
 * for the current transaction status.
 */
export interface PaymentFailure {
  category: PaymentErrorCategory;
  /** User-safe message — never contains secrets or implies premature success. */
  message: string;
  /** Current canonical transaction status at the time of failure. */
  transactionStatus: PaymentStatus | null;
  /** Preserved idempotency context so retries never duplicate a payment. */
  idempotency: {
    paymentId: string;
    bookingId: string | null;
    eventHash: string | null;
    /** True when a signed transaction already exists and must not be resubmitted. */
    signedTransactionExists: boolean;
    stellarTxHash: string | null;
  };
  /** Only actions that are safe for the current transaction status. */
  allowedActions: PaymentNextAction[];
  /** Whether the caller may safely retry the same operation. */
  retryable: boolean;
}

export type PaymentOperationResult<T> =
  | { success: true; data: T }
  | { success: false; failure: PaymentFailure };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hex digest of an event payload object.
 * Used to detect duplicate provider callbacks.
 */
export function hashEventPayload(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Returns true when `from → to` is a permitted transition.
 */
export function isAllowedTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Map an external provider status string to a canonical PaymentStatus.
 * Returns `under_review` for any unknown value.
 */
export function mapProviderStatus(raw: string): PaymentStatus {
  return PROVIDER_STATUS_MAP[raw] ?? 'under_review';
}

/**
 * Returns true when the payment has already had a signed transaction
 * submitted (or is otherwise past the point where resubmission is safe).
 */
export function hasSignedTransaction(payment: Payment): boolean {
  return (
    payment.status === 'submitted' ||
    payment.status === 'confirmed' ||
    payment.status === 'refunded' ||
    (payment.stellar_tx_hash !== null && payment.stellar_tx_hash !== '')
  );
}

/**
 * Build a structured PaymentFailure from an error and the current payment
 * (if known). Preserves idempotency context and computes safe next actions.
 */
export function buildPaymentFailure(
  error: unknown,
  payment: Payment | null,
  eventHash?: string | null,
): PaymentFailure {
  const context: PaymentErrorContext = {
    transactionStatus: payment?.status ?? null,
    signedTransactionExists: payment ? hasSignedTransaction(payment) : false,
    providerStatus: null,
  };

  const classified = classifyPaymentError(error, context);
  const response: PaymentErrorResponse = buildPaymentErrorResponse(classified, context);

  return {
    category: response.category,
    message: response.message,
    transactionStatus: payment?.status ?? null,
    idempotency: {
      paymentId: payment?.id ?? '',
      bookingId: payment?.booking_id ?? null,
      eventHash: eventHash ?? payment?.last_event_hash ?? null,
      signedTransactionExists: context.signedTransactionExists,
      stellarTxHash: payment?.stellar_tx_hash ?? null,
    },
    allowedActions: response.allowedActions,
    retryable: response.retryable,
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create a new payment intent in `pending` state.
 *
 * @returns The newly created Payment record.
 * @throws  On database error.
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
): Promise<Payment> {
  const { bookingId, tenantId, amountStroops, quoteHash, escrowId, metadata } = params;

  const { data, error } = await supabase
    .from('payments')
    .insert({
      booking_id: bookingId,
      tenant_id: tenantId,
      amount_stroops: amountStroops.toString(), // stored as text to avoid JS bigint loss
      currency: 'USDC',
      status: 'pending',
      escrow_id: escrowId ?? null,
      quote_hash: quoteHash ?? null,
      version: 1,
      last_event_hash: null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create payment intent: ${error?.message ?? 'unknown error'}`);
  }

  const payment = rowToPayment(data);

  await auditLogger.log({
    actorId: tenantId,
    action: 'payment.submit',
    resourceType: 'payment',
    resourceId: payment.id,
    meta: { bookingId, amountStroops: amountStroops.toString() },
  });

  return payment;
}

/**
 * Transition a payment to a new status with full idempotency and conflict
 * quarantine.
 *
 * Algorithm:
 *  1. Load current payment with optimistic version.
 *  2. Hash the incoming event payload.
 *  3. If `last_event_hash` matches → replay without side-effects.
 *  4. Verify the transition is allowed; if not → quarantine to `under_review`.
 *  5. Apply the update with version increment; on version conflict retry once.
 *
 * @param paymentId    - UUID of the payment to transition.
 * @param newStatus    - Target status.
 * @param eventPayload - Raw event data (used for duplicate detection).
 * @param txHash       - Optional Stellar transaction hash to record.
 * @param actorId      - Optional actor UUID for audit (omit for system actions).
 *
 * @returns TransitionResult containing updated Payment and replayed flag.
 */
export async function transitionPaymentStatus(
  paymentId: string,
  newStatus: PaymentStatus,
  eventPayload: Record<string, unknown>,
  txHash?: string | null,
  actorId?: string,
): Promise<ServiceResponse<TransitionResult>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  const eventHash = hashEventPayload(eventPayload);

  // ── Idempotency: same event hash → replay without side-effects ────────────
  if (payment.last_event_hash === eventHash) {
    return {
      success: true,
      data: { payment, replayed: true },
    };
  }

  // ── Refuse resubmission of an already-signed transaction ──────────────────
  // A signed transaction must never be resubmitted; doing so risks a
  // duplicate payment. Quarantine for reconciliation instead.
  if (newStatus === 'submitted' && isResubmissionBlocked(payment.status, hasSignedTransaction(payment))) {
    const failure = buildPaymentFailure(
      { category: 'already_signed' as PaymentErrorCategory },
      payment,
      eventHash,
    );
    await auditLogger.log({
      actorId,
      action: 'payment.failed',
      resourceType: 'payment',
      resourceId: paymentId,
      meta: {
        reason: 'resubmission_blocked',
        fromStatus: payment.status,
        toStatus: newStatus,
        stellarTxHash: payment.stellar_tx_hash,
      },
    });
    return {
      success: false,
      error: failure.message,
    };
  }

  // ── Validate transition ────────────────────────────────────────────────────
  let targetStatus: PaymentStatus = newStatus;
  let quarantineReason: string | undefined;

  if (!isAllowedTransition(payment.status, newStatus)) {
    // Unknown or regressive transition → quarantine
    targetStatus = 'under_review';
    quarantineReason = `Disallowed transition: ${payment.status} → ${newStatus}`;
  }

  // ── Persist with optimistic concurrency ───────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    version: payment.version + 1,
    last_event_hash: eventHash,
    updated_at: new Date().toISOString(),
  };
  if (txHash !== undefined) updatePayload.stellar_tx_hash = txHash;
  if (quarantineReason) {
    // Store quarantine reason in metadata for manual review
    updatePayload.metadata = {
      ...(payment.metadata ?? {}),
      quarantine_reason: quarantineReason,
      quarantined_at: new Date().toISOString(),
    };
  }

  const { data, error } = await supabase
    .from('payments')
    .update(updatePayload)
    .eq('id', paymentId)
    .eq('version', payment.version) // optimistic concurrency guard
    .select()
    .single();

  if (error || !data) {
    // Version conflict — another process transitioned first. Preserve
    // idempotency context so the caller can safely retry.
    const failure = buildPaymentFailure(
      { category: 'conflict' as PaymentErrorCategory },
      payment,
      eventHash,
    );
    return {
      success: false,
      error: failure.message,
    };
  }

  const updated = rowToPayment(data);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const auditAction =
    targetStatus === 'confirmed'  ? ('payment.confirmed' as const) :
    targetStatus === 'failed'     ? ('payment.failed'    as const) :
    targetStatus === 'refunded'   ? ('payment.failed'    as const) :
    ('payment.submit' as const);

  await auditLogger.log({
    actorId,
    action: auditAction,
    resourceType: 'payment',
    resourceId: paymentId,
    meta: {
      fromStatus: payment.status,
      toStatus: targetStatus,
      txHash,
      quarantineReason,
    },
  });

  // Alert on quarantine
  if (targetStatus === 'under_review') {
    console.error(
      `[Payment] QUARANTINE paymentId=${paymentId} reason="${quarantineReason}" payload=%j`,
      eventPayload,
    );
  }

  return {
    success: true,
    data: { payment: updated, replayed: false },
  };
}

/**
 * @deprecated Use transitionPaymentStatus() instead.
 *
 * Retained for backward-compatibility with stellar.service.ts callers that
 * have not yet been migrated to the new API.
 */
export async function updatePaymentStatus(
  paymentId: string,
  txHash: string | null,
  status: PaymentStatus,
): Promise<Payment> {
  const result = await transitionPaymentStatus(
    paymentId,
    status,
    { txHash, status, _source: 'stellar_confirmation' },
    txHash,
  );

  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'Failed to update payment status');
  }

  return result.data.payment;
}

/**
 * Submit a signed transaction for a payment, enforcing attempt limits and
 * provider circuit breakers before any provider call is made.
 *
 * The caller supplies an idempotency key (typically the payment's event hash
 * or quote hash) and the actor performing the submission. Attempts are
 * counted per actor + booking + idempotency key so repeated failures stop
 * generating provider calls.
 *
 * @returns A structured result; on failure the PaymentFailure carries safe
 *          next actions and preserved idempotency context.
 */
export async function submitSignedTransaction(params: {
  paymentId: string;
  actorId: string;
  idempotencyKey: string;
  /** Provider call that performs the actual submission. */
  submit: () => Promise<{ txHash: string }>;
}): Promise<PaymentOperationResult<TransitionResult>> {
  const { paymentId, actorId, idempotencyKey, submit } = params;

  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return {
      success: false,
      failure: buildPaymentFailure({ category: 'not_found' as PaymentErrorCategory }, null, idempotencyKey),
    };
  }

  // Refuse to resubmit an already-signed transaction.
  if (hasSignedTransaction(payment)) {
    return {
      success: false,
      failure: buildPaymentFailure(
        { category: 'already_signed' as PaymentErrorCategory },
        payment,
        idempotencyKey,
      ),
    };
  }

  // ── Circuit breaker check before any provider call ────────────────────────
  const circuit = await checkCircuitBreaker('stellar');
  if (!circuit.closed) {
    return {
      success: false,
      failure: buildPaymentFailure(
        { category: 'provider_unavailable' as PaymentErrorCategory },
        payment,
        idempotencyKey,
      ),
    };
  }

  // ── Attempt limit check ───────────────────────────────────────────────────
  const attempt = await recordPaymentAttempt({
    actorId,
    bookingId: payment.booking_id,
    idempotencyKey,
  });
  if (!attempt.allowed) {
    return {
      success: false,
      failure: buildPaymentFailure(
        { category: 'rate_limited' as PaymentErrorCategory },
        payment,
        idempotencyKey,
      ),
    };
  }

  // ── Provider call ─────────────────────────────────────────────────────────
  let txHash: string;
  try {
    const result = await submit();
    txHash = result.txHash;
    await recordProviderOutcome('stellar', { success: true });
  } catch (err) {
    await recordProviderOutcome('stellar', { success: false, error: err });
    return {
      success: false,
      failure: buildPaymentFailure(err, payment, idempotencyKey),
    };
  }

  // ── Persist the submitted transition ──────────────────────────────────────
  const transition = await transitionPaymentStatus(
    paymentId,
    'submitted',
    { txHash, idempotencyKey, _source: 'submit_signed_transaction' },
    txHash,
    actorId,
  );

  if (!transition.success || !transition.data) {
    return {
      success: false,
      failure: buildPaymentFailure(
        { category: 'internal' as PaymentErrorCategory },
        payment,
        idempotencyKey,
      ),
    };
  }

  return { success: true, data: transition.data };
}

/**
 * Get a payment record by ID. Returns null if not found.
 */
export async function getPaymentStatus(paymentId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('id', paymentId)
    .single();
  return data ? rowToPayment(data) : null;
}

/**
 * Get a payment record by booking ID. Returns null if not found.
 */
export async function getPaymentByBookingId(bookingId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('booking_id', bookingId)
    .single();
  return data ? rowToPayment(data) : null;
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Map a raw Supabase row to a typed Payment, handling BigInt conversion.
 */
// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToPayment(row: any): Payment {
  return {
    id:               row.id,
    booking_id:       row.booking_id,
    tenant_id:        row.tenant_id,
    amount_stroops:   BigInt(row.amount_stroops ?? row.amount_usdc ?? 0),
    currency:         row.currency ?? 'USDC',
    stellar_tx_hash:  row.stellar_tx_hash ?? null,
    escrow_id:        row.escrow_id ?? null,
    quote_hash:       row.quote_hash ?? null,
    status:           row.status as PaymentStatus,
    version:          row.version ?? 1,
    last_event_hash:  row.last_event_hash ?? null,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
    metadata:         row.metadata ?? null,
  };
}
