/**
 * Refund service — executes refunds from a booking-time policy snapshot (#769).
 *
 * Problem solved:
 *   Cancellation rules may change after booking.  If the refund is computed
 *   from the *current* policy at cancellation time, the tenant may receive
 *   less (or more) than the terms they agreed to at booking.  This service
 *   snapshots the refund policy at booking creation time and uses that
 *   snapshot for all refund calculations, regardless of later policy changes.
 *
 * Flow:
 *   1. createRefundSnapshot() — called at booking creation; stores the policy
 *      config that was active at that moment.
 *   2. computeRefundFromSnapshot() — called at cancellation; computes the
 *      refund from the snapshot, not the live policy.
 *   3. createRefundRequest() — creates an idempotent refund request in
 *      'requested' state.
 *   4. transitionRefundStatus() — moves the request through settlement states:
 *        requested → submitted → confirmed
 *        requested → submitted → failed → manual_review
 *      Each transition is validated against the allowed state graph.
 *   5. getRefundRequest() — exposes the current status to the user.
 *
 * Idempotency:
 *   Refund requests are keyed by (booking_id, source_ref).  A duplicate call
 *   with the same source_ref returns the existing request without side-effects.
 *
 *   Refund *execution* is additionally keyed on a durable escrow operation key
 *   (operation_key) plus the provider reference (provider_ref).  The request
 *   fingerprint is persisted before the external submission, so a retry after a
 *   timeout can never move funds twice: ambiguous outcomes stay in 'submitted'
 *   (pending verification) until the provider state is queried, and retries are
 *   bounded by MAX_REFUND_ATTEMPTS.
 *
 * Settlement states:
 *   requested    — refund request created, awaiting submission to provider
 *   submitted     — refund submitted to escrow/provider, awaiting confirmation
 *                   (also the "ambiguous" state after a timeout — never retried
 *                   until provider state has been reconciled)
 *   confirmed    — refund confirmed on-chain, funds returned to tenant
 *   failed       — provider rejected the refund (recoverable — can retry)
 *   manual_review — refund stuck after failure; requires ops intervention
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import { logger } from './logger.service.js';
import {
  computeRefund,
  getRefundPolicyConfig,
  type RefundPolicyConfig,
  type RefundComputation,
  type RefundTierId,
} from './refundPolicy.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RefundStatus =
  | 'requested'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'manual_review';

/**
 * Allowed forward transitions in the refund settlement state machine.
 * Any move not listed here is rejected.
 */
const ALLOWED_REFUND_TRANSITIONS: Readonly<Record<RefundStatus, ReadonlyArray<RefundStatus>>> = {
  requested:     ['submitted', 'failed', 'manual_review'],
  submitted:     ['confirmed', 'failed', 'manual_review'],
  confirmed:     [],                    // terminal
  failed:        ['submitted', 'manual_review'],  // retryable
  manual_review: ['submitted', 'failed'],         // ops resolution
};

export interface RefundSnapshot {
  id: string;
  booking_id: string;
  /** Policy config captured at booking time. */
  policy: RefundPolicyConfig;
  /** The booking total price at the time of booking. */
  total_price: number;
  /** ISO timestamp when the snapshot was created. */
  created_at: string;
}

/**
 * Durable escrow operation key for a refund.  Deterministic per booking so a
 * retried submission always maps to the same provider-side operation.
 */
export function buildRefundOperationKey(bookingId: string, idempotencyKey?: string): string {
  return `refund:${bookingId}:${idempotencyKey ?? `refund:${bookingId}`}`;
}

/** Maximum number of provider submission attempts before manual review. */
export const MAX_REFUND_ATTEMPTS = 3;

export interface RefundRequest {
  id: string;
  booking_id: string;
  tenant_id: string;
  host_id: string;
  /** Refund amount in currency units. */
  refund_amount: number;
  /** Refund tier: full | partial | none. */
  refund_tier: RefundTierId;
  /** Refund fraction (0..1) from the snapshot policy. */
  refund_policy_pct: number;
  currency: string;
  status: RefundStatus;
  /** Unique key preventing duplicate refund requests for the same event. */
  idempotency_key: string;
  /** Escrow contract ID the refund was sent to. */
  destination_escrow_id: string | null;
  /** Stellar transaction hash for the refund, if submitted. */
  tx_hash: string | null;
  /** Snapshot ID the refund was computed from. */
  snapshot_id: string;
  /** Error message from the provider, if failed. */
  error_message: string | null;
  /** Number of retry attempts. */
  attempt_count: number;
  /** Durable escrow operation key — stable across retries. */
  operation_key: string | null;
  /** Provider-side reference returned by the escrow service, if any. */
  provider_ref: string | null;
  /** Fingerprint of the submission request, persisted before external call. */
  request_fingerprint: string | null;
  /** Correlation ID propagated from the originating request. */
  correlation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefundOperationContext {
  /** Correlation ID from the originating API request. */
  correlationId?: string;
  /** Operation ID for this refund attempt (defaults to operation_key). */
  operationId?: string;
}

export interface CreateRefundSnapshotParams {
  bookingId: string;
  policy?: RefundPolicyConfig;
  totalPrice: number;
}

export interface CreateRefundRequestParams {
  bookingId: string;
  tenantId: string;
  hostId: string;
  cancelledAt: Date;
  idempotencyKey?: string;
  destinationEscrowId?: string;
  correlationId?: string;
}

export interface SubmitRefundParams {
  refundId: string;
  /** Provider submission callback. Must be safe to call at most once per operation key. */
  submit: (req: {
    operationKey: string;
    providerRef: string | null;
    amount: number;
    currency: string;
    destinationEscrowId: string | null;
    correlationId: string | null;
    bookingId: string;
    operationId: string;
  }) => Promise<{ providerRef?: string | null; txHash?: string | null }>;
  /** Provider state query used to reconcile ambiguous outcomes. */
  queryProviderState: (req: {
    operationKey: string;
    providerRef: string | null;
    correlationId: string | null;
    bookingId: string;
  }) => Promise<'confirmed' | 'failed' | 'pending' | 'not_found'>;
  context?: RefundOperationContext;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isAllowedRefundTransition(from: RefundStatus, to: RefundStatus): boolean {
  return ALLOWED_REFUND_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Deterministic fingerprint of a refund submission.  Persisted before the
 * external call so a retry can be compared against the original request.
 */
export function computeRefundFingerprint(input: {
  bookingId: string;
  operationKey: string;
  amount: number;
  currency: string;
  destinationEscrowId: string | null;
}): string {
  const canonical = [
    input.bookingId,
    input.operationKey,
    input.amount.toFixed(6),
    input.currency,
    input.destinationEscrowId ?? '',
  ].join('|');
  // Simple, stable, non-cryptographic hash is sufficient for equality checks.
  let hash = 0;
  for (let i = 0; i < canonical.length; i++) {
    hash = (hash * 31 + canonical.charCodeAt(i)) | 0;
  }
  return `fp_${(hash >>> 0).toString(16)}_${canonical.length}`;
}

// ─── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Create a refund policy snapshot at booking creation time.
 *
 * The snapshot captures the *exact* refund policy config that was active when
 * the tenant booked.  This ensures the refund calculation at cancellation uses
 * the terms the tenant agreed to, even if the platform changes the policy
 * later.
 *
 * @returns The created snapshot, or an existing snapshot if one already exists
 *          for this booking (idempotent).
 */
export async function createRefundSnapshot(
  params: CreateRefundSnapshotParams,
): Promise<ServiceResponse<RefundSnapshot>> {
  if (!params.bookingId) {
    return { success: false, error: 'bookingId is required' };
  }

  const policy = params.policy ?? getSnapshotPolicyConfig();
  const totalPrice = params.totalPrice;

  // Check if a snapshot already exists (idempotent)
  const { data: existing, error: existingError } = await supabase
    .from('refund_policy_snapshots')
    .select('*')
    .eq('booking_id', params.bookingId)
    .maybeSingle();

  if (existingError) {
    return { success: false, error: `Failed to load refund snapshot: ${existingError.message}` };
  }
  if (existing) {
    return { success: true, data: rowToSnapshot(existing) };
  }

  const row = {
    booking_id:  params.bookingId,
    policy:       policy,
    total_price:  totalPrice,
    created_at:   new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('refund_policy_snapshots')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to create refund snapshot: ${error?.message ?? 'unknown'}` };
  }

  return { success: true, data: rowToSnapshot(data) };
}

/**
 * Retrieve the refund policy snapshot for a booking.
 */
export async function getRefundSnapshot(bookingId: string): Promise<ServiceResponse<RefundSnapshot | null>> {
  if (!bookingId) return { success: false, error: 'bookingId is required' };

  const { data, error } = await supabase
    .from('refund_policy_snapshots')
    .select('*')
    .eq('booking_id', bookingId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  return { success: true, data: data ? rowToSnapshot(data) : null };
}

/**
 * Compute the refund from a booking-time policy snapshot.
 *
 * Uses the snapshot policy (not the live policy) so the refund matches the
 * terms the tenant agreed to at booking time.
 *
 * @param bookingId     - UUID of the booking being cancelled
 * @param checkIn       - Check-in date (ISO string)
 * @param cancelledAt   - Cancellation timestamp
 * @param overrideTotal - Override the snapshot total (for price modifications)
 */
export async function computeRefundFromSnapshot(
  bookingId: string,
  checkIn: string,
  cancelledAt: Date,
  overrideTotal?: number,
): Promise<ServiceResponse<RefundComputation & { snapshotId: string }>> {
  const snapshotResult = await getRefundSnapshot(bookingId);
  if (!snapshotResult.success) return { success: false, error: snapshotResult.error };

  const snapshot = snapshotResult.data;
  if (!snapshot) {
    return { success: false, error: 'No refund policy snapshot found for this booking' };
  }

  const totalPrice = overrideTotal ?? snapshot.total_price;

  let computation: RefundComputation;
  try {
    computation = computeRefund({
      totalPrice,
      checkIn,
      cancelledAt,
      config: snapshot.policy,
    });
  } catch (err) {
    return { success: false, error: `Refund computation failed: ${String(err)}` };
  }

  return {
    success: true,
    data: { ...computation, snapshotId: snapshot.id },
  };
}

// ─── Refund request lifecycle ─────────────────────────────────────────────────

/**
 * Create an idempotent refund request.
 *
 * If a request with the same (booking_id, idempotency_key) already exists,
 * the existing request is returned without side-effects.
 *
 * The refund amount is computed from the booking-time policy snapshot, not the
 * live policy.  This ensures the refund cannot exceed the eligible value under
 * the terms the tenant agreed to at booking time.
 *
 * Settlement state starts at 'requested'.
 *
 * @returns The created (or existing) refund request.
 */
export async function createRefundRequest(
  params: CreateRefundRequestParams,
): Promise<ServiceResponse<RefundRequest>> {
  if (!params.bookingId) return { success: false, error: 'bookingId is required' };
  if (!params.tenantId)  return { success: false, error: 'tenantId is required' };
  if (!params.hostId)    return { success: false, error: 'hostId is required' };

  // 1. Load the booking to get check-in date and total price
  const { data: booking, error: bookingErr } = await supabase
    .from('bookings')
    .select('id, check_in, total_price, escrow_id, status')
    .eq('id', params.bookingId)
    .single();

  if (bookingErr || !booking) {
    return { success: false, error: 'Booking not found' };
  }

  const bookingRow = booking as { id: string; check_in: string; total_price: number; escrow_id: string | null; status: string };

  // 2. Compute refund from the snapshot (not the live policy)
  const snapshotResult = await getRefundSnapshot(params.bookingId);
  if (!snapshotResult.success) return { success: false, error: snapshotResult.error };
  if (!snapshotResult.data) {
    return { success: false, error: 'No refund policy snapshot found for this booking' };
  }

  const eligibleTotal = Math.min(
    snapshotResult.data.total_price,
    Number(bookingRow.total_price),
  );
  const refundResult = await computeRefundFromSnapshot(
    params.bookingId,
    bookingRow.check_in,
    params.cancelledAt,
    eligibleTotal,
  );

  if (!refundResult.success || !refundResult.data) {
    return { success: false, error: refundResult.error ?? 'Failed to compute refund' };
  }

  const refund = refundResult.data;
  const idempotencyKey = params.idempotencyKey ?? `refund:${params.bookingId}`;
  const operationKey = buildRefundOperationKey(params.bookingId, idempotencyKey);

  // 3. Check for existing request (idempotent)
  const { data: existing, error: existingError } = await supabase
    .from('refund_requests')
    .select('*')
    .eq('booking_id', params.bookingId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingError) {
    return { success: false, error: `Failed to check existing refund request: ${existingError.message}` };
  }
  if (existing) {
    return { success: true, data: rowToRefundRequest(existing) };
  }

  // 4. Create the refund request in 'requested' state
  const row = {
    booking_id:           params.bookingId,
    tenant_id:            params.tenantId,
    host_id:              params.hostId,
    refund_amount:        refund.refundAmount,
    refund_tier:          refund.tier,
    refund_policy_pct:    refund.refundPct,
    currency:             'USDC',
    status:               'requested',
    idempotency_key:      idempotencyKey,
    destination_escrow_id: params.destinationEscrowId ?? bookingRow.escrow_id,
    tx_hash:              null,
    snapshot_id:          refund.snapshotId,
    error_message:        null,
    attempt_count:        0,
    operation_key:        operationKey,
    provider_ref:         null,
    request_fingerprint:  null,
    correlation_id:       params.correlationId ?? null,
  };

  const { data, error } = await supabase
    .from('refund_requests')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      const { data: duplicate, error: duplicateError } = await supabase
        .from('refund_requests')
        .select('*')
        .eq('booking_id', params.bookingId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (duplicateError) {
        return { success: false, error: `Failed to load duplicate refund request: ${duplicateError.message}` };
      }
      if (duplicate) return { success: true, data: rowToRefundRequest(duplicate) };
    }
    return { success: false, error: `Failed to create refund request: ${error?.message ?? 'unknown'}` };
  }

  const request = rowToRefundRequest(data);

  await auditLogger.log({
    actorId: params.tenantId,
    action: 'payment.refund',
    resourceType: 'payment',
    resourceId: request.id,
    meta: {
      bookingId: params.bookingId,
      refundAmount: refund.refundAmount,
      tier: refund.tier,
      status: 'requested',
      fromSnapshot: true,
      operationKey,
      correlationId: params.correlationId ?? null,
    },
  });

  logger.info('refund.request.created', {
    correlationId: params.correlationId ?? null,
    bookingId: params.bookingId,
    operationId: operationKey,
    refundId: request.id,
    status: 'requested',
  });

  return { success: true, data: request };
}

/**
 * Submit a refund to the escrow provider exactly once per operation key.
 *
 * Guarantees:
 *   - The request fingerprint is persisted *before* the external call.
 *   - A retry with a different fingerprint is rejected (no silent double-spend).
 *   - A timeout / ambiguous outcome leaves the request in 'submitted' and is
 *     reconciled against provider state before any further submission.
 *   - Retries are bounded by MAX_REFUND_ATTEMPTS; exceeding it escalates to
 *     manual_review.
 *   - correlation_id / booking_id / operation_id are propagated to logs and
 *     the provider callback.
 */
export async function submitRefund(
  params: SubmitRefundParams,
): Promise<ServiceResponse<RefundRequest>> {
  if (!params.refundId) return { success: false, error: 'refundId is required' };

  const { data: current, error: loadErr } = await supabase
    .from('refund_requests')
    .select('*')
    .eq('id', params.refundId)
    .single();

  if (loadErr || !current) {
    return { success: false, error: 'Refund request not found' };
  }

  const request = rowToRefundRequest(current);
  const operationKey = request.operation_key ?? buildRefundOperationKey(request.booking_id, request.idempotency_key);
  const correlationId = params.context?.correlationId ?? request.correlation_id ?? null;
  const operationId = params.context?.operationId ?? operationKey;

  const logCtx = {
    correlationId,
    bookingId: request.booking_id,
    operationId,
    refundId: request.id,
  };

  // Terminal states: nothing to do.
  if (request.status === 'confirmed') {
    return { success: true, data: request };
  }

  // Ambiguous / in-flight: reconcile against provider before retrying.
  if (request.status === 'submitted') {
    const reconciled = await reconcileRefund({
      request,
      operationKey,
      correlationId,
      operationId,
      queryProviderState: params.queryProviderState,
    });
    if (!reconciled.success) return reconciled;
    if (reconciled.data?.status === 'confirmed') {
      return { success: true, data: reconciled.data };
    }
    if (reconciled.data?.status === 'submitted') {
      // Still ambiguous — do NOT resubmit.
      logger.warn('refund.submit.ambiguous_pending', logCtx);
      return { success: true, data: reconciled.data };
    }
    // Reconciled to failed → fall through to bounded retry.
  }

  if (request.status === 'manual_review') {
    return { success: false, error: 'Refund is in manual_review; ops intervention required' };
  }

  if (request.attempt_count >= MAX_REFUND_ATTEMPTS) {
    await transitionRefundStatus(request.id, 'manual_review', {
      errorMessage: `Exceeded max refund attempts (${MAX_REFUND_ATTEMPTS})`,
      actorId: 'system',
    });
    logger.error('refund.submit.attempts_exhausted', { ...logCtx, attempts: request.attempt_count });
    return { success: false, error: 'Refund retry limit reached; escalated to manual_review' };
  }

  // Persist the request fingerprint BEFORE the external submission.
  const fingerprint = computeRefundFingerprint({
    bookingId: request.booking_id,
    operationKey,
    amount: request.refund_amount,
    currency: request.currency,
    destinationEscrowId: request.destination_escrow_id,
  });

  if (request.request_fingerprint && request.request_fingerprint !== fingerprint) {
    logger.error('refund.submit.fingerprint_mismatch', {
      ...logCtx,
      storedFingerprint: request.request_fingerprint,
      incomingFingerprint: fingerprint,
    });
    return { success: false, error: 'Refund request fingerprint mismatch; refusing to resubmit' };
  }

  const { error: prepErr } = await supabase
    .from('refund_requests')
    .update({
      operation_key: operationKey,
      request_fingerprint: fingerprint,
      correlation_id: correlationId,
      status: 'submitted',
      updated_at: new Date().toISOString(),
    })
    .eq('id', request.id)
    .in('status', ['requested', 'failed']);

  if (prepErr) {
    return { success: false, error: `Failed to persist refund submission: ${prepErr.message}` };
  }

  logger.info('refund.submit.started', { ...logCtx, attempt: request.attempt_count + 1 });

  let providerRef: string | null = request.provider_ref;
  let txHash: string | null = null;
  try {
    const result = await params.submit({
      operationKey,
      providerRef: request.provider_ref,
      amount: request.refund_amount,
      currency: request.currency,
      destinationEscrowId: request.destination_escrow_id,
      correlationId,
      bookingId: request.booking_id,
      operationId,
    });
    providerRef = result.providerRef ?? providerRef;
    txHash = result.txHash ?? null;
  } catch (err) {
    // Ambiguous: the provider may have accepted.  Stay in 'submitted' and
    // reconcile before any retry.
    logger.warn('refund.submit.ambiguous_error', { ...logCtx, error: String(err) });
    const reconciled = await reconcileRefund({
      request: { ...request, status: 'submitted', provider_ref: providerRef },
      operationKey,
      correlationId,
      operationId,
      queryProviderState: params.queryProviderState,
    });
    if (reconciled.success && reconciled.data) {
      return { success: true, data: reconciled.data };
    }
    return { success: false, error: `Refund submission ambiguous: ${String(err)}` };
  }

  const { data: updated, error: updateErr } = await supabase
    .from('refund_requests')
    .update({
      status: 'submitted',
      provider_ref: providerRef,
      tx_hash: txHash,
      attempt_count: (request.attempt_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', request.id)
    .eq('status', 'submitted')
    .select()
    .maybeSingle();

  if (updateErr || !updated) {
    return { success: false, error: updateErr?.message ?? 'Refund submission state changed concurrently' };
  }

  logger.info('refund.submit.accepted', { ...logCtx, providerRef, hasTxHash: Boolean(txHash) });
  return { success: true, data: rowToRefundRequest(updated) };
}

/**
 * Reconcile an ambiguous refund against provider state.
 *
 * Returns the request unchanged (status 'submitted') when the provider state is
 * still pending or unknown — callers must not resubmit in that case.
 */
async function reconcileRefund(input: {
  request: RefundRequest;
  operationKey: string;
  correlationId: string | null;
  operationId: string;
  queryProviderState: SubmitRefundParams['queryProviderState'];
}): Promise<ServiceResponse<RefundRequest>> {
  const { request, operationKey, correlationId, operationId } = input;
  const logCtx = {
    correlationId,
    bookingId: request.booking_id,
    operationId,
    refundId: request.id,
  };

  let providerState: 'confirmed' | 'failed' | 'pending' | 'not_found';
  try {
    providerState = await input.queryProviderState({
      operationKey,
      providerRef: request.provider_ref,
      correlationId,
      bookingId: request.booking_id,
    });
  } catch (err) {
    logger.warn('refund.reconcile.query_failed', { ...logCtx, error: String(err) });
    return { success: true, data: request };
  }

  logger.info('refund.reconcile.result', { ...logCtx, providerState });

  if (providerState === 'confirmed') {
    const res = await transitionRefundStatus(request.id, 'confirmed', { actorId: 'system' });
    return res.success ? res : { success: true, data: request };
  }
  if (providerState === 'failed' || providerState === 'not_found') {
    const res = await transitionRefundStatus(request.id, 'failed', {
      errorMessage: `Provider state: ${providerState}`,
      actorId: 'system',
    });
    return res.success ? res : { success: true, data: request };
  }
  // pending / unknown → remain ambiguous
  return { success: true, data: request };
}

/**
 * Transition a refund request to a new settlement status.
 *
 * Validates the transition against the allowed state graph.  Invalid
 * transitions are rejected.
 *
 * @param refundId   - UUID of the refund request
 * @param newStatus  - Target status
 * @param txHash     - Optional Stellar tx hash (for submitted/confirmed)
 * @param errorMessage - Error message (for failed)
 * @param actorId    - Actor making the transition (for audit)
 */
export async function transitionRefundStatus(
  refundId: string,
  newStatus: RefundStatus,
  options?: {
    txHash?: string | null;
    errorMessage?: string | null;
    actorId?: string;
  },
): Promise<ServiceResponse<RefundRequest>> {
  if (!refundId) return { success: false, error: 'refundId is required' };

  // Load current request
  const { data: current, error: loadErr } = await supabase
    .from('refund_requests')
    .select('*')
    .eq('id', refundId)
    .single();

  if (loadErr || !current) {
    return { success: false, error: 'Refund request not found' };
  }

  const currentRequest = rowToRefundRequest(current);

  // Validate transition
  if (!isAllowedRefundTransition(currentRequest.status, newStatus)) {
    return {
      success: false,
      error: `Invalid refund transition: ${currentRequest.status} → ${newStatus}`,
    };
  }

  const updatePayload: Record<string, unknown> = {
    status: newStatus,
    updated_at: new Date().toISOString(),
  };

  if (options?.txHash !== undefined) updatePayload.tx_hash = options.txHash;
  if (options?.errorMessage !== undefined) updatePayload.error_message = options.errorMessage;
  if (newStatus === 'submitted') updatePayload.attempt_count = (currentRequest.attempt_count ?? 0) + 1;

  const { data: updated, error: updateErr } = await supabase
    .from('refund_requests')
    .update(updatePayload)
    .eq('id', refundId)
    .eq('status', currentRequest.status)
    .select()
    .maybeSingle();

  if (updateErr || !updated) {
    return {
      success: false,
      error: updateErr?.message
        ? `Failed to update refund status: ${updateErr.message}`
        : 'Refund status changed concurrently; reload and retry',
    };
  }

  const request = rowToRefundRequest(updated);

  // Audit log
  await auditLogger.log({
    actorId: options?.actorId,
    action: 'payment.refund',
    resourceType: 'payment',
    resourceId: refundId,
    meta: {
      fromStatus: currentRequest.status,
      toStatus: newStatus,
      txHash: options?.txHash,
      errorMessage: options?.errorMessage,
    },
  });

  // Escalate to manual review on failure
  if (newStatus === 'manual_review') {
    logger.error('refund.manual_review', {
      correlationId: currentRequest.correlation_id,
      bookingId: currentRequest.booking_id,
      operationId: currentRequest.operation_key,
      refundId,
      lastError: currentRequest.error_message,
    });
  }

  return { success: true, data: request };
}

/**
 * Get a refund request by ID.
 */
export async function getRefundRequest(refundId: string): Promise<ServiceResponse<RefundRequest | null>> {
  if (!refundId) return { success: false, error: 'refundId is required' };

  const { data, error } = await supabase
    .from('refund_requests')
    .select('*')
    .eq('id', refundId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  return { success: true, data: data ? rowToRefundRequest(data) : null };
}

/**
 * Get the refund request for a booking (if any).
 */
export async function getRefundRequestByBooking(
  bookingId: string,
): Promise<ServiceResponse<RefundRequest | null>> {
  if (!bookingId) return { success: false, error: 'bookingId is required' };

  const { data, error } = await supabase
    .from('refund_requests')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  return { success: true, data: data ? rowToRefundRequest(data) : null };
}

/**
 * Get the refund calculation for user-facing display *before* confirming
 * cancellation.  This lets the user see exactly what they'll receive.
 *
 * @returns The refund computation (tier, percentage, amount) from the snapshot.
 */
export async function getRefundPreview(
  bookingId: string,
  checkIn: string,
  cancelledAt: Date = new Date(),
): Promise<ServiceResponse<RefundComputation & { snapshotId: string }>> {
  if (!bookingId) return { success: false, error: 'bookingId is required' };
  const snapshotResult = await computeRefundFromSnapshot(bookingId, checkIn, cancelledAt);
  if (snapshotResult.success || !snapshotResult.error?.includes('No refund policy snapshot')) {
    return snapshotResult;
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('total_price')
    .eq('id', bookingId)
    .single();
  if (error || !booking) {
    return { success: false, error: error?.message ?? 'Booking not found' };
  }

  try {
    const computation = computeRefund({
      totalPrice: Number(booking.total_price),
      checkIn,
      cancelledAt,
    });
    return {
      success: true,
      data: { ...computation, snapshotId: 'legacy-live-policy' },
    };
  } catch (err) {
    return { success: false, error: `Refund computation failed: ${String(err)}` };
  }
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToSnapshot(row: any): RefundSnapshot {
  return {
    id:          row.id,
    booking_id:  row.booking_id,
    policy:      row.policy as RefundPolicyConfig,
    total_price: Number(row.total_price) || 0,
    created_at:  row.created_at,
  };
}

// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToRefundRequest(row: any): RefundRequest {
  return {
    id:                    row.id,
    booking_id:            row.booking_id,
    tenant_id:             row.tenant_id,
    host_id:               row.host_id,
    refund_amount:         Number(row.refund_amount) || 0,
    refund_tier:           row.refund_tier as RefundTierId,
    refund_policy_pct:    Number(row.refund_policy_pct) || 0,
    currency:              row.currency ?? 'USDC',
    status:                row.status as RefundStatus,
    idempotency_key:       row.idempotency_key,
    destination_escrow_id: row.destination_escrow_id ?? null,
    tx_hash:               row.tx_hash ?? null,
    snapshot_id:           row.snapshot_id,
    error_message:         row.error_message ?? null,
    attempt_count:         Number(row.attempt_count) || 0,
    operation_key:         row.operation_key ?? null,
    provider_ref:          row.provider_ref ?? null,
    request_fingerprint:   row.request_fingerprint ?? null,
    correlation_id:        row.correlation_id ?? null,
    created_at:            row.created_at,
    updated_at:            row.updated_at,
  };
}

// ─── Snapshot policy resolution ─────────────────────────────────────────────

/**
 * Resolve the refund policy config to snapshot at booking time.
 * This calls the existing refundPolicy.service.ts to get the *live* config,
 * which is then frozen in the snapshot.
 */
function getSnapshotPolicyConfig(): RefundPolicyConfig {
  return getRefundPolicyConfig();
}
