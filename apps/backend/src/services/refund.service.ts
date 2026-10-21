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
 * Settlement states:
 *   requested    — refund request created, awaiting submission to provider
 *   submitted     — refund submitted to escrow/provider, awaiting confirmation
 *   confirmed    — refund confirmed on-chain, funds returned to tenant
 *   failed       — provider rejected the refund (recoverable — can retry)
 *   manual_review — refund stuck after failure; requires ops intervention
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
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
  created_at: string;
  updated_at: string;
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isAllowedRefundTransition(from: RefundStatus, to: RefundStatus): boolean {
  return ALLOWED_REFUND_TRANSITIONS[from]?.includes(to) ?? false;
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
    },
  });

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
    console.error(
      `[Refund] MANUAL_REVIEW refundId=${refundId} bookingId=${currentRequest.booking_id} ` +
      `lastError="${currentRequest.error_message}"`,
    );
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
