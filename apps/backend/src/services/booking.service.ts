/**
 * Booking service — orchestrates availability check → escrow creation →
 * DB insert → on-chain booking creation in a single atomic-ish flow with
 * rollback on failure.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { supabase } from '@/config/supabase.js';
import { normalizeStayRange, calendarDateToEpochSeconds } from '@/utils/date.utils.js';
import { env } from '@/config/env.js';
import {
  checkAvailability,
  cancelBookingOnChain,
  createBookingOnChain,
  updateBookingStatusOnChain,
} from '@/blockchain/bookingContract.js';
import { trustlessWorkClient } from '@/blockchain/trustlessWork.js';
import { loggingService } from './logging.service.js';
import {
  createNotification,
  enqueueNotificationOutbox,
  getPreferences,
} from './notification.service.js';
import { emailService } from './email.service.js';
import { buildPreferenceUrlForUser } from './preferenceToken.js';
import { computeRefund } from './refundPolicy.service.js';
import { recordBookingSettlement } from './ledger.service.js';
import {
  createRefundSnapshot,
  createRefundRequest,
  computeRefundFromSnapshot,
  transitionRefundStatus,
  getRefundPreview,
  type RefundStatus,
} from './refund.service.js';
import { decodeCursor, buildCursorPage } from '../utils/cursor.js';
import type { CursorPaginatedResult } from './notification.service.js';
import type { ServiceResponse } from './index.js';
import {
  incCounter,
  bookingsCreatedTotal,
  escrowFailuresTotal,
} from '@/middleware/metrics.middleware.js';
import { checkDateRangeAvailability } from './availability.service.js';
import { calculateRangePrice, pricingSnapshotFromQuote } from './pricing.service.js';
import {
  bookingAuthorizationService,
  type BookingActor,
} from './bookingAuthorization.service.js';
import { auditLogger } from './auditLogger.service.js';

// ─── Atomic availability helpers ───────────────────────────────────────────────

/**
 * Postgres exclusion-constraint violation code. Fired by `bookings_no_date_overlap`
 * (see migration 00062_booking_date_exclusion_constraint.sql) whenever a write
 * — whether through create_booking_atomic_v2 or a direct UPDATE such as a
 * modification acceptance — would create two overlapping active reservations
 * for the same property. This is the DB-level authoritative guard; any write
 * path that mutates check_in/check_out must be prepared to receive it.
 */
const PG_EXCLUSION_VIOLATION = '23P01';

/** How long a host has to act on a booking-modification proposal before it auto-expires. */
const MODIFICATION_PROPOSAL_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

/** True when a Supabase/Postgres error is an exclusion-constraint conflict. */
function isExclusionViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === PG_EXCLUSION_VIOLATION;
}

/**
 * True when a 'pending' modification proposal's TTL has passed but the
 * cleanup sweep hasn't yet flipped its status to 'expired'. Callers must
 * treat this the same as an already-expired proposal: a host cannot approve
 * or decline a proposal whose window has closed, even in the gap before the
 * sweep runs.
 */
function isLazilyExpiredModification(modification: BookingModification): boolean {
  return (
    modification.status === 'pending' &&
    !!modification.expires_at &&
    new Date(modification.expires_at).getTime() < Date.now()
  );
}

/**
 * Standard, tenant-safe 409 response for a date-overlap conflict. Never
 * includes the identity or details of the other booking/tenant holding the
 * conflicting dates — only that the requested interval is no longer free.
 */
function dateConflictResponse(): ServiceResponse<never> {
  return {
    success: false,
    error: 'Requested dates are no longer available — they were just reserved by another booking',
    conflict: true,
    statusCode: 409,
    code: 'BOOKING_OVERLAP',
  } as ServiceResponse<never>;
}

/**
 * Booking states that reserve inventory (block the property's dates).
 *
 * This is the single source of truth mirrored by the DB exclusion constraint
 * `bookings_no_date_overlap` (migration 00062): a row in one of these states
 * holds its [check_in, check_out) interval against every other active row for
 * the same property. Terminal states (Cancelled, Expired, Completed) release
 * the dates. `Pending` is included because a pending-payment hold must block
 * competing tenants until it expires or is cancelled.
 */
export const RESERVING_BOOKING_STATUSES = ['Pending', 'Confirmed', 'Disputed'] as const;

/** True when a booking status holds inventory. */
export function isReservingStatus(status: string | null | undefined): boolean {
  return !!status && (RESERVING_BOOKING_STATUSES as readonly string[]).includes(status);
}

// ─── State machine ────────────────────────────────────────────────────────────

/**
 * Exhaustive map of every valid booking status transition.
 * Any transition not listed here is rejected with HTTP 409.
 *
 * Terminal states (Completed, Cancelled, Expired) have empty arrays —
 * nothing can follow them.
 */
export const VALID_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  Pending:   ['Confirmed', 'Cancelled', 'Expired'],
  Confirmed: ['Completed', 'Cancelled', 'Disputed'],
  Disputed:  ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
  Expired:   [],
} as const;

export const TERMINAL_STATES = new Set(['Completed', 'Cancelled', 'Expired']);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Booking {
  id: string;
  property_id?: string;
  tenant_id?: string;
  check_in?: string;
  check_out?: string;
  guest_count?: number;
  total_price?: number;
  status?: string;
  escrow_id?: string;
  on_chain_id?: number;
  rules_acknowledged_at?: string | null;
  /** Set when a booking is cancelled; ISO timestamp of the cancellation. */
  cancelled_at?: string | null;
  /** Amount refunded to the tenant on cancellation (currency units). */
  refund_amount?: number | null;
  /** Refund tier applied on cancellation: 'full' | 'partial' | 'none'. */
  refund_tier?: string | null;
  /** Refund fraction (0..1) applied per the configured policy. */
  refund_policy_pct?: number | null;
  /** UTC instant at which a Pending booking will be automatically expired. */
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface BookingStatusHistory {
  id: string;
  booking_id: string;
  /** Status the booking transitioned FROM. Null for the initial creation entry. */
  from_status?: string | null;
  status: string;
  changed_by?: string;
  reason?: string;
  notes?: string;
  created_at: string;
}

export interface BookingModification {
  id: string;
  booking_id: string;
  requested_start: string;
  requested_end: string;
  original_start: string;
  original_end: string;
  /** Guest count on the booking when the request was created. */
  original_guest_count?: number | null;
  /** New guest count being requested; null means no occupancy change. */
  requested_guest_count?: number | null;
  status: string;
  requested_by: string;
  reason?: string;
  /** Price of the booking before the modification was requested. */
  original_total_price?: number | null;
  /** Repriced total after the modification is accepted. */
  new_total_price?: number | null;
  /** new_total_price − original_total_price. Positive means more is owed. */
  price_delta?: number | null;
  /** True when delta > 0 and the tenant must authorise an additional payment. */
  requires_additional_payment?: boolean;
  /** Full JSON snapshot of the booking row at request time — immutable audit record. */
  booking_snapshot?: Record<string, unknown> | null;
  /** When an unacted-on proposal auto-expires; null for legacy rows created before this existed. */
  expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreateBookingInput {
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  guest_count: number;
  total_price: number;
  rules_acknowledged_at?: string;
  /** Platform policy version string the tenant agreed to (from GET /api/v1/policy/current). */
  terms_version?: string;
  /** UTC timestamp when the tenant accepted the terms. */
  terms_accepted_at?: string;
  on_chain_property_id?: bigint;
  /** Quote token from GET /properties/:id/quote, binding total_price to the quoted stay. */
  quote_token?: string;
}

export interface RequestModificationInput {
  booking_id: string;
  tenant_id: string;
  requested_start: string;
  requested_end: string;
  /** Optional occupancy change; validated against property max_guests. */
  guest_count?: number;
  reason?: string;
}

/**
 * Interface for blockchain dependencies — kept narrow so it can be mocked in tests.
 */
export interface BlockchainServices {
  checkAvailability(propertyOnChainId: bigint, checkIn: bigint, checkOut: bigint): Promise<boolean>;

  createBookingOnChain(
    propertyId: bigint,
    userId: string,
    startDate: bigint,
    endDate: bigint,
    totalPrice: bigint,
  ): Promise<bigint>;

  cancelBookingOnChain(bookingId: bigint, callerAddress: string): Promise<void>;

  updateBookingStatusOnChain(
    bookingId: bigint,
    newStatus: string,
    callerAddress: string,
  ): Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchStellarAddress(userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('stellar_address')
    .eq('id', userId)
    .single();
  return (data as { stellar_address?: string } | null)?.stellar_address ?? null;
}

// ─── Service class ────────────────────────────────────────────────────────────

export class BookingService {
  private readonly blockchain: BlockchainServices;

  constructor(blockchainServices?: BlockchainServices) {
    this.blockchain = blockchainServices ?? {
      checkAvailability,
      createBookingOnChain,
      cancelBookingOnChain,
      updateBookingStatusOnChain,
    };
  }

  // ── State machine ──────────────────────────────────────────────────────────

  /**
   * Validate, apply, and record a booking status transition atomically.
   *
   * Checks the transition against VALID_TRANSITIONS and returns HTTP 409
   * (conflict) for any path not in the map. On success the booking row is
   * updated and a fully-enriched history record (from_status, actor, reason)
   * is inserted.
   *
   * @param extra - Additional columns to update alongside `status` (e.g. cancelled_at).
   */
  private async transitionStatus(
    bookingId: string,
    fromStatus: string,
    toStatus: string,
    actorId: string,
    reason?: string,
    extra?: Record<string, unknown>,
  ): Promise<ServiceResponse<Booking>> {
    const allowed = VALID_TRANSITIONS[fromStatus];
    if (!allowed) {
      return {
        success: false,
        error: `Unknown booking status '${fromStatus}'`,
        statusCode: 409,
      };
    }
    if (!allowed.includes(toStatus)) {
      const msg =
        fromStatus === toStatus
          ? `Booking is already ${toStatus.toLowerCase()}`
          : `Cannot transition booking from '${fromStatus}' to '${toStatus}'`;
      return { success: false, error: msg, statusCode: 409 };
    }

    const payload: Record<string, unknown> = { status: toStatus, ...extra };

    // Condition the write on the expected current status ("optimistic claim").
    // Without this, two concurrent callers racing on the same booking (e.g. an
    // expiry sweep and a payment-confirmation webhook both acting on a
    // Pending booking) would both succeed, double-writing history/notifications
    // and letting whichever write lands last silently clobber the other's
    // outcome. With it, only the caller that still sees the expected
    // `fromStatus` wins; the loser's update matches zero rows and is reported
    // back as a (non-error) no-op so retries and reruns stay idempotent.
    const { data, error } = await supabase
      .from('bookings')
      .update(payload)
      .eq('id', bookingId)
      .eq('status', fromStatus)
      .select()
      .maybeSingle();

    if (error) {
      // A status flip that re-enters a reserving state (e.g. a late-confirmation
      // Pending → Confirmed) can trip the exclusion constraint if another
      // booking claimed the dates after this hold was (incorrectly) considered
      // released. Surface the same tenant-safe 409 rather than the raw error.
      if (isExclusionViolation(error)) {
        return dateConflictResponse();
      }
      return { success: false, error: error.message };
    }

    // Durable audit trail: await the history write (rather than fire-and-forget)
    // so a crash between these two statements is the only way to lose a history
    // record, not an ordinary async scheduling race. The status transition has
    // already committed above; a history-write failure is logged loudly but does
    // not roll back or fail the caller, since the booking/payment state must
    // stay the source of truth even if the audit insert needs manual backfill.
    try {
      const { error: historyError } = await supabase.from('booking_status_history').insert({
        booking_id: bookingId,
        from_status: fromStatus,
        status: toStatus,
        changed_by: actorId || null,
        reason: reason ?? null,
      });
      if (historyError) {
        console.error(
          `[BookingService] CRITICAL: history insert failed for booking=${bookingId} ${fromStatus}->${toStatus}:`,
          historyError,
        );
      }
    } catch (e) {
      console.error(
        `[BookingService] CRITICAL: history insert threw for booking=${bookingId} ${fromStatus}->${toStatus}:`,
        e,
      );
    }

    return { success: true, data: data as Booking };
  }

  // ── Expiry cleanup ─────────────────────────────────────────────────────────

  /**
   * Expire all Pending bookings whose expires_at has passed.
   *
   * Safe to rerun and safe under concurrent schedulers:
   *  - Each expiry write is conditioned on the booking still being `Pending`
   *    (see `transitionStatus`), so a second runner — or a payment webhook
   *    racing this sweep — can never double-process or clobber a booking
   *    another caller already moved on.
   *  - Before expiring, the booking's real escrow/payment status is checked
   *    on-chain/with the payment provider. A payment that actually cleared
   *    (funded/released) just after the hold window closed is treated as a
   *    "late confirmation": the booking is moved to Confirmed instead of
   *    Expired, and the tenant/host are notified of the outcome either way.
   *    This is what prevents a late, legitimate payment from being silently
   *    discarded by the sweep.
   */
  async expireStaleBookings(): Promise<ServiceResponse<{ expired: number; failed: number }>> {
    const { data: stale, error } = await supabase
      .from('bookings')
      .select('id, status, escrow_id, tenant_id, expires_at')
      .eq('status', 'Pending')
      .lt('expires_at', new Date().toISOString())
      .not('expires_at', 'is', null);

    if (error) return { success: false, error: error.message };

    let expired = 0;
    let failed = 0;

    for (const b of stale ?? []) {
      try {
        // Check the real payment state before releasing inventory. A booking
        // whose escrow actually funded/released in the gap between the hold
        // expiring and this sweep running must NOT be silently expired —
        // that would discard a legitimate payment.
        let paymentCleared = false;
        if (b.escrow_id) {
          try {
            const escrowStatus = await trustlessWorkClient.getEscrowStatus(b.escrow_id);
            paymentCleared = escrowStatus.status === 'funded' || escrowStatus.status === 'released';
          } catch (e) {
            console.warn('[expiry] Could not verify escrow status for', b.id, '— treating as unpaid:', e);
          }
        }

        if (paymentCleared) {
          // Late confirmation: honor the payment instead of expiring the hold.
          const confirmResult = await this.transitionStatus(
            b.id,
            'Pending',
            'Confirmed',
            'system',
            'Payment cleared after the expiry sweep ran — hold honored instead of expired',
          );

          // A STALE_TRANSITION (already moved by another caller, e.g. the
          // normal confirmation webhook) is an expected, idempotent no-op here.
          if (!confirmResult.success && confirmResult.code !== 'STALE_TRANSITION') {
            failed++;
            continue;
          }

          if (confirmResult.success && b.tenant_id) {
            createNotification(b.tenant_id, 'booking_late_confirmation', { booking_id: b.id }).catch(() => {});
          }
          continue;
        }

        // Release escrow back to tenant (non-fatal)
        if (b.escrow_id) {
          await trustlessWorkClient.cancelEscrow(b.escrow_id).catch((e: unknown) =>
            console.warn('[expiry] Escrow cancel failed for', b.id, ':', e),
          );
        }

        // Payment state is resolved (unpaid) before this write: the escrow
        // cancel above has been attempted and the status flip to Expired —
        // a non-reserving terminal state — is what releases the dates. If the
        // escrow cancel failed we still expire the hold (the payment provider
        // will not settle an unfunded escrow), but the transition is atomic and
        // conditioned on the booking still being Pending.
        const result = await this.transitionStatus(
          b.id,
          'Pending',
          'Expired',
          'system',
          'Booking expired — payment not received within the allowed window',
        );

        if (!result.success) {
          // Another runner/webhook already claimed this booking — not a failure.
          if (result.code === 'STALE_TRANSITION') continue;
          failed++;
          continue;
        }

        if (b.tenant_id) {
          createNotification(b.tenant_id, 'booking_expired', { booking_id: b.id }).catch(() => {});
        }

        expired++;
      } catch (e) {
        console.error('[expiry] Failed to expire booking', b.id, ':', e);
        failed++;
      }
    }

    return { success: true, data: { expired, failed } };
  }

  /**
   * Notify tenants (and hosts) of Pending bookings whose hold is about to
   * expire, so they get a chance to complete payment before the slot is
   * released. Each booking is warned at most once: the claim is atomic
   * (`expiry_warning_sent_at IS NULL` in both the WHERE and the write), so
   * rerunning this on every scheduler tick never sends duplicate warnings.
   *
   * @param windowMinutes - how soon (from now) a booking must expire to warn.
   */
  async sendExpiryWarnings(
    windowMinutes = 15,
  ): Promise<ServiceResponse<{ warned: number; failed: number }>> {
    const horizon = new Date(Date.now() + windowMinutes * 60 * 1000).toISOString();

    const { data: candidates, error } = await supabase
      .from('bookings')
      .select('id, tenant_id, property_id, expires_at')
      .eq('status', 'Pending')
      .is('expiry_warning_sent_at', null)
      .not('expires_at', 'is', null)
      .lt('expires_at', horizon)
      .gt('expires_at', new Date().toISOString());

    if (error) return { success: false, error: error.message };

    let warned = 0;
    let failed = 0;

    for (const b of candidates ?? []) {
      // Atomic claim: only the caller that flips expiry_warning_sent_at from
      // NULL wins. A second concurrent tick sees zero rows updated and skips.
      const { data: claimed, error: claimError } = await supabase
        .from('bookings')
        .update({ expiry_warning_sent_at: new Date().toISOString() })
        .eq('id', b.id)
        .is('expiry_warning_sent_at', null)
        .select('id')
        .maybeSingle();

      if (claimError) {
        failed++;
        continue;
      }
      if (!claimed) continue; // already warned by another runner

      if (b.tenant_id) {
        createNotification(b.tenant_id, 'booking_hold_expiring_soon', {
          booking_id: b.id,
          expires_at: b.expires_at,
        }).catch(() => {});
      }
      warned++;
    }

    return { success: true, data: { warned, failed } };
  }

  /**
   * Expire booking-modification proposals the host never acted on.
   *
   * Only the proposal row changes — the underlying booking's dates, price,
   * and history are untouched, so an expired proposal leaves the original
   * booking exactly as it was (no hold to release, since modification
   * proposals never mutate the booking until accepted).
   *
   * The write is conditioned on `status = 'pending'` so this is safe to
   * rerun and safe against a host accepting/declining the same proposal in
   * the same instant: whichever write lands first wins, the other is a
   * harmless no-op.
   */
  async expireStaleModifications(): Promise<ServiceResponse<{ expired: number; failed: number }>> {
    const { data: stale, error } = await supabase
      .from('booking_modifications')
      .select('id, booking_id, requested_by')
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString())
      .not('expires_at', 'is', null);

    if (error) return { success: false, error: error.message };

    let expired = 0;
    let failed = 0;

    for (const m of stale ?? []) {
      const { data: updated, error: updateError } = await supabase
        .from('booking_modifications')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', m.id)
        .eq('status', 'pending') // atomic claim — mirrors transitionStatus's booking guard
        .select('id')
        .maybeSingle();

      if (updateError) {
        failed++;
        continue;
      }
      if (!updated) continue; // already accepted/declined/expired by another caller

      if (m.requested_by) {
        createNotification(m.requested_by, 'booking_modification_expired', {
          booking_id: m.booking_id,
          modification_id: m.id,
        }).catch(() => {});
      }
      expired++;
    }

    return { success: true, data: { expired, failed } };
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /**
   * Retrieve a booking by its ID.
   *
   * @param id - UUID of the booking
   * @returns ServiceResponse with the booking data, or error if not found
   * @example
   * const result = await bookingService.getBookingById('f47ac10b-58cc-4372-a567-0e02b2c3d479');
   * if (result.success) {
   *   console.log(result.data.status); // 'Pending', 'Confirmed', etc.
   * }
   */
  async getBookingById(id: string): Promise<ServiceResponse<Booking>> {
    if (!id) {
      return { success: false, error: 'Booking ID is required' };
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      return { success: false, error: 'Booking ID must be a valid UUID' };
    }

    const { data, error } = await supabase.from('bookings').select('*').eq('id', id).single();

    if (error) {
      return { success: false, error: 'Booking not found' };
    }

    return { success: true, data: data as Booking };
  }

  /**
   * Get the status history for a booking.
   *
   * @param bookingId - UUID of the booking
   * @returns ServiceResponse with the status history array
   */
  async getBookingStatusHistory(bookingId: string): Promise<ServiceResponse<BookingStatusHistory[]>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    const { data, error } = await supabase
      .from('booking_status_history')
      .select('*')
      .eq('booking_id', bookingId)
      .order('created_at', { ascending: true });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: (data ?? []) as BookingStatusHistory[] };
  }

  /**
   * List bookings for a user (as tenant) with optional status filtering and
   * sorting, backed by cursor-based pagination.
   *
   * Cursor pagination is only supported when `sort === 'created'`. The cursor
   * payload encodes `(created_at, id)` as a keyset and drives a WHERE predicate
   * that advances the window correctly. The `date` and `price` sort fields use
   * nullable columns (`check_in`, `total_price`) whose NULL-safe multi-column
   * keyset predicates are not currently implemented. Supplying a cursor with
   * either of those sort modes returns an explicit error so the caller is never
   * silently served a duplicate or restarted page.
   *
   * @param userId  - UUID of the tenant
   * @param cursor  - Opaque pagination cursor (omit for first page; only valid with sort='created')
   * @param limit   - Page size (1–100, default 20)
   * @param status  - Filter by booking status
   * @param sort    - Sort field: 'date' (check_in) | 'price' (total_price) | 'created' (default)
   * @param order   - Sort direction: 'asc' | 'desc' (default 'desc')
   */
  async getUserBookings(
    userId: string,
    page = 1,
    pageSize = 20,
    status?: string | null,
    sort: 'date' | 'price' | 'created' = 'created',
    order: 'asc' | 'desc' = 'desc',
  ): Promise<ServiceResponse<PaginatedResult<Booking>>> {
    const trimmedUserId = (userId ?? '').trim();
    if (!trimmedUserId) {
      return { success: false, error: 'User ID is required' };
    }

    if (!Number.isInteger(page) || page < 1) return { success: false, error: 'page must be a positive integer' };
    if (!Number.isInteger(pageSize) || pageSize < 1) return { success: false, error: 'pageSize must be a positive integer' };
    pageSize = Math.min(pageSize, 100);

    const sortColumn = sort === 'date' ? 'check_in' : sort === 'price' ? 'total_price' : 'created_at';
    const ascending = order === 'asc';

    let query = supabase
      .from('bookings')
      .select('*', { count: 'exact' })
      .eq('tenant_id', trimmedUserId)
      .order(sortColumn, { ascending })
      .order('id', { ascending: false });

    if (status) {
      const KNOWN_STATUSES = ['Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed'] as const;
      const trimmedStatus = status.trim();
      if (trimmedStatus) {
        const normalised = KNOWN_STATUSES.find(
          (s) => s.toLowerCase() === trimmedStatus.toLowerCase(),
        );
        if (!normalised) {
          return {
            success: false,
            error: `Invalid status '${trimmedStatus}'. Must be one of: ${KNOWN_STATUSES.join(', ')}`,
          };
        }
        query = query.eq('status', normalised);
      }
    }

    const response = await executePaginatedQuery(query, page, pageSize);
    if (response.error) return { success: false, error: response.error };
    return { success: true, data: response.result };
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Full booking creation flow:
   *   1. Fetch property + owner Stellar address
   *   2. Fetch buyer Stellar address
   *   3. Validate both Stellar addresses
   *   4. Check on-chain availability
   *   5. Create TrustlessWork escrow
   *   6. Insert booking into Supabase
   *   7. Create on-chain booking record
   */
  async createBooking(input: CreateBookingInput): Promise<ServiceResponse<Booking>> {
    const { property_id, tenant_id, check_in, check_out, guest_count, total_price, rules_acknowledged_at, terms_version, terms_accepted_at } = input;

    if (!property_id || !tenant_id || !check_in || !check_out) {
      return {
        success: false,
        error: 'property_id, tenant_id, check_in, and check_out are required',
      };
    }

    if (!Number.isFinite(total_price) || total_price <= 0) {
      return { success: false, error: 'total_price must be a positive number' };
    }

    if (!Number.isFinite(guest_count) || !Number.isInteger(guest_count) || guest_count < 1) {
      return { success: false, error: 'guest_count must be at least 1' };
    }

    // Require rules acknowledgement
    if (!rules_acknowledged_at) {
      return {
        success: false,
        error: 'You must acknowledge the house rules before booking',
      };
    }

    // Normalize to canonical property-local calendar dates once, here at the
    // API boundary (see apps/backend/src/utils/date.utils.ts). This avoids
    // DST/leap-day drift from diffing raw Date instants in milliseconds.
    const stayRange = normalizeStayRange(check_in, check_out);
    if ('error' in stayRange) {
      return { success: false, error: stayRange.error };
    }
    const { checkIn: normalizedCheckIn, checkOut: normalizedCheckOut, nights } = stayRange;

    // 1. Fetch property + owner (include capacity and stay-length limits)
    const { data: property, error: propertyError } = await supabase
      .from('properties')
      .select('id, owner_id, on_chain_id, max_guests, min_nights, max_nights, check_in_time, check_out_time, deleted_at, draft_status, moderation_state')
      .eq('id', property_id)
      .single();

    if (propertyError || !property) {
      return { success: false, error: 'Property not found' };
    }

    const prop = property as {
      id: string;
      owner_id: string;
      on_chain_id?: number;
      max_guests?: number;
      min_nights?: number;
      max_nights?: number | null;
      check_in_time?: string;
      check_out_time?: string;
      deleted_at?: string | null;
      draft_status?: string | null;
      moderation_state?: string | null;
    };

    // Reject bookings against soft-deleted (removed) listings
    if (prop.deleted_at) {
      return { success: false, error: 'This property is no longer available for booking' };
    }

    // Drafts are not bookable. A listing hidden by moderation stops accepting new
    // bookings, but bookings made before the hide are not changed.
    if (prop.draft_status === 'draft') {
      return { success: false, error: 'This property is not available for booking' };
    }
    if (prop.moderation_state === 'hidden') {
      return {
        success: false,
        error: 'This property is temporarily unavailable for new bookings',
        statusCode: 409,
        code: 'LISTING_HIDDEN',
      };
    }

    // Capacity check
    if (prop.max_guests !== undefined && prop.max_guests !== null && guest_count > prop.max_guests) {
      return {
        success: false,
        error: `Guest count (${guest_count}) exceeds property capacity (${prop.max_guests})`,
      };
    }

    // Stay-length check (nights computed above from canonical calendar dates)
    const minNights = prop.min_nights ?? 1;
    if (nights < minNights) {
      return {
        success: false,
        error: `This property requires a minimum stay of ${minNights} night${minNights === 1 ? '' : 's'} (requested: ${nights})`,
      };
    }
    if (prop.max_nights !== null && prop.max_nights !== undefined && nights > prop.max_nights) {
      return {
        success: false,
        error: `This property allows a maximum stay of ${prop.max_nights} night${prop.max_nights === 1 ? '' : 's'} (requested: ${nights})`,
      };
    }

    // Same-day turnover check: if an existing booking checks out on our check-in day,
    // only allow it when the property's check_out_time precedes its check_in_time.
    if (prop.check_in_time && prop.check_out_time) {
      const { data: sameDayBooking } = await supabase
        .from('bookings')
        .select('id')
        .eq('property_id', property_id)
        .eq('check_out', normalizedCheckIn)
        .neq('status', 'Cancelled')
        .maybeSingle();

      if (sameDayBooking && prop.check_out_time >= prop.check_in_time) {
        return {
          success: false,
          error: `Same-day check-in is not available: the property's check-out time (${prop.check_out_time}) does not precede its check-in time (${prop.check_in_time})`,
        };
      }
    }

    // 1b. Re-price the stay on the server. The tenant's total must match a fresh
    //     quote (and a supplied quote token, if any) before dates are reserved or
    //     funds are authorised. The server total is what gets charged.
    const priceCheck = await assertQuotedTotal({
      propertyId: property_id,
      checkIn:    check_in,
      checkOut:   check_out,
      clientTotal: total_price,
      quoteToken:  input.quote_token,
      guestCount:  guest_count,
    });
    if (!priceCheck.success || !priceCheck.data) {
      return {
        success: false,
        error: priceCheck.error,
        statusCode: priceCheck.statusCode,
        conflict: priceCheck.conflict,
        code: priceCheck.code,
        details: priceCheck.details,
      };
    }
    const chargedTotal = priceCheck.data.total;

    // Capture the listing terms the tenant is agreeing to, at the same point the
    // price is confirmed. This is stored with the booking and never changes after.
    const termsSnapshot = await captureListingTermsSnapshot(property_id);
    if (!termsSnapshot.success || !termsSnapshot.data) {
      return { success: false, error: 'Could not record the listing terms for this booking' };
    }

    // 2. Fetch Stellar addresses
    const [ownerStellarAddress, buyerStellarAddress] = await Promise.all([
      fetchStellarAddress(prop.owner_id),
      fetchStellarAddress(tenant_id),
    ]);

    // 3. Validate addresses
    if (!ownerStellarAddress || !StrKey.isValidEd25519PublicKey(ownerStellarAddress)) {
      return {
        success: false,
        error: 'Property owner does not have a valid Stellar address',
      };
    }

    if (!buyerStellarAddress || !StrKey.isValidEd25519PublicKey(buyerStellarAddress)) {
      return {
        success: false,
        error: 'Tenant does not have a valid Stellar address',
      };
    }

    // 4. Atomically reserve the booking (conflict check + host-block check + INSERT).
    //    This must happen before escrow so escrow is never created for a conflicting slot.
    const { data: reservedId, error: reservationError } = await supabase.rpc(
      'create_booking_atomic_v2',
      {
        p_property_id: property_id,
        p_tenant_id: tenant_id,
        p_check_in: normalizedCheckIn,
        p_check_out: normalizedCheckOut,
        p_total_price: chargedTotal,
        p_guest_count: guest_count,
        p_rules_acknowledged_at: rules_acknowledged_at ?? null,
        p_terms_version: terms_version ?? null,
        p_terms_accepted_at: terms_accepted_at ?? null,
      },
    );

    if (reservationError) {
      // The atomic RPC takes a per-property advisory lock and inserts under the
      // exclusion constraint, so a competing request for overlapping dates
      // either sees BOOKING_CONFLICT or trips the constraint (23P01). Both map
      // to the same stable, tenant-safe 409 — never the raw DB error.
      if (isExclusionViolation(reservationError)) {
        return dateConflictResponse();
      }
      const msg = reservationError.message ?? '';
      if (msg.includes('BOOKING_CONFLICT')) {
        return dateConflictResponse();
      }
      if (msg.includes('BOOKING_BLOCKED')) {
        return {
          success: false,
          error: 'These dates are blocked by the host',
          conflict: true,
          statusCode: 409,
          code: 'BOOKING_BLOCKED',
        };
      }
      return { success: false, error: reservationError.message };
    }

    const bookingId = reservedId as string;

    // Store the agreed listing terms on the booking. The snapshot is immutable
    // (see migration 00065), so this is the only write that sets it.
    // The accepted quote is stored with the terms, in the same write, so the booking
    // records the exact nightly prices and rules the tenant agreed to (#926).
    const { error: snapshotError } = await supabase
      .from('bookings')
      .update({
        listing_terms_snapshot: termsSnapshot.data.terms,
        listing_revision: termsSnapshot.data.revision,
        pricing_version: priceCheck.data.quote.pricing_version ?? null,
        pricing_snapshot: pricingSnapshotFromQuote(priceCheck.data.quote),
      })
      .eq('id', bookingId);

    if (snapshotError) {
      await supabase.from('bookings').delete().eq('id', bookingId);
      return { success: false, error: 'Could not record the listing terms for this booking' };
    }

    // 5. Check on-chain availability (advisory; non-blocking on error).
    if (prop.on_chain_id !== undefined && prop.on_chain_id !== null) {
      const checkInTs = calendarDateToEpochSeconds(normalizedCheckIn);
      const checkOutTs = calendarDateToEpochSeconds(normalizedCheckOut);

      loggingService.logBlockchainOperation('checkAvailability', {
        propertyId: property_id,
        userId: tenant_id,
      });

      try {
        const available = await this.blockchain.checkAvailability(
          BigInt(prop.on_chain_id),
          checkInTs,
          checkOutTs,
        );

        if (!available) {
          // Roll back the DB reservation
          await supabase.from('bookings').delete().eq('id', bookingId);
          return {
            success: false,
            error: 'Property is not available for the requested dates',
          };
        }
      } catch (err) {
        loggingService.logBlockchainOperation(
          'checkAvailability',
          { propertyId: property_id, userId: tenant_id },
          undefined,
          String(err),
        );
        console.warn('[BookingService] On-chain availability check failed:', err);
      }
    }

    // 6. Create TrustlessWork escrow (after local reservation succeeds).
    let escrowId: string | undefined;

    loggingService.logBlockchainOperation('createEscrow', {
      propertyId: property_id,
      userId: tenant_id,
    });

    try {
      const escrowResponse = await trustlessWorkClient.createBookingEscrow({
        propertyId: property_id,
        bookingId,
        buyerAddress: buyerStellarAddress,
        sellerAddress: ownerStellarAddress,
        amountUsdc: String(chargedTotal),
        checkIn: check_in,
        checkOut: check_out,
      });
      escrowId = escrowResponse.escrowId;

      loggingService.logBlockchainOperation('createEscrow', {
        propertyId: property_id,
        userId: tenant_id,
        escrowId,
      });
    } catch (err) {
      loggingService.logBlockchainOperation(
        'createEscrow',
        { propertyId: property_id, userId: tenant_id },
        undefined,
        String(err),
      );
      incCounter(escrowFailuresTotal, { operation: 'create_escrow' });
      // Roll back the DB reservation so the slot is freed
      await supabase.from('bookings').delete().eq('id', bookingId);
      return {
        success: false,
        error: `Failed to create escrow: ${String(err)}`,
      };
    }

    // 7. Attach escrow_id and expiry timestamp to the reserved booking.
    const expiresAt = new Date(
      Date.now() + (env.PENDING_BOOKING_EXPIRY_HOURS ?? 24) * 3_600_000,
    ).toISOString();

    const { data: bookingData, error: updateError } = await supabase
      .from('bookings')
      .update({ escrow_id: escrowId, expires_at: expiresAt })
      .eq('id', bookingId)
      .select()
      .single();

    if (updateError) {
      // Attempt escrow rollback
      try {
        if (escrowId) await trustlessWorkClient.cancelEscrow(escrowId);
      } catch (rollbackErr) {
        console.error('[BookingService] Escrow rollback failed:', rollbackErr);
      }
      return { success: false, error: updateError.message };
    }

    const booking = bookingData as Booking;

    // Record initial history entry for the Pending state.
    supabase
      .from('booking_status_history')
      .insert({
        booking_id: booking.id,
        from_status: null,
        status: 'Pending',
        changed_by: tenant_id,
        reason: 'Booking created',
      })
      .then(() => {})
      .catch((e: unknown) => console.warn('[BookingService] Initial history insert failed:', e));

    // Notify tenant (in-app)
    createNotification(tenant_id, 'booking_created', { booking_id: booking.id, property_id }).catch(
      () => {},
    );
    incCounter(bookingsCreatedTotal, { property_id });

    // 8. Create on-chain booking record (non-fatal on failure).
    if (prop.on_chain_id !== undefined && prop.on_chain_id !== null) {
      const checkInTs = calendarDateToEpochSeconds(normalizedCheckIn);
      const checkOutTs = calendarDateToEpochSeconds(normalizedCheckOut);

      loggingService.logBlockchainOperation('createBookingOnChain', {
        bookingId: booking.id,
        propertyId: property_id,
        userId: tenant_id,
      });

      try {
        const onChainId = await this.blockchain.createBookingOnChain(
          BigInt(prop.on_chain_id),
          buyerStellarAddress,
          checkInTs,
          checkOutTs,
          BigInt(Math.round(chargedTotal * 1e7)),
        );

        loggingService.logBlockchainOperation('createBookingOnChain', {
          bookingId: booking.id,
          propertyId: property_id,
          userId: tenant_id,
          onChainId: String(onChainId),
        });

        await supabase
          .from('bookings')
          .update({ on_chain_id: Number(onChainId) })
          .eq('id', booking.id);

        booking.on_chain_id = Number(onChainId);
      } catch (err) {
        loggingService.logBlockchainOperation(
          'createBookingOnChain',
          { bookingId: booking.id, propertyId: property_id, userId: tenant_id },
          undefined,
          String(err),
        );
        console.warn('[BookingService] On-chain booking creation failed:', err);
      }
    }

    return { success: true, data: booking };
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  /**
   * Cancel a booking as the tenant.
   *
   * The flow:
   *   1. Load the booking (joined with its property owner for host notification).
   *   2. Authorise: only the tenant may cancel.
   *   3. Validate eligibility: the booking must be in a cancellable state
   *      (not already Cancelled, Completed, or Disputed).
   *   4. Compute the refund amount from the configured refund policy.
   *   5. Drive the appropriate escrow action for the refund tier.
   *   6. Persist the cancellation (status, cancelled_at, refund details).
   *   7. Notify both the tenant and the host.
   *   8. Update the on-chain booking status (non-fatal on failure).
   *
   * Refund tiers (see refundPolicy.service.ts, configurable via env):
   *   • full    (>= fullRefundHours before check-in) → escrow cancelled back to
   *             the tenant (100% refund).
   *   • partial (between noRefundHours and fullRefundHours) → escrow released to
   *             the host, who is responsible for returning the tenant's
   *             `refund_amount` (recorded on the booking).
   *   • none    (< noRefundHours before check-in) → escrow released to the host,
   *             no refund owed to the tenant.
   *
   * @param bookingId - UUID of the booking to cancel
   * @param userId    - ID of the caller (must be the tenant)
   * @param now       - Cancellation timestamp (defaults to now; injectable for tests)
   */
  async cancelBooking(
    bookingId: string,
    userId: string,
    now: Date = new Date(),
    userRole?: string,
  ): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    // 1. Load booking + host owner id in a single round-trip
    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties?: { owner_id: string } | null };
    const hostId = booking.properties?.owner_id ?? null;

    // 2. Authorisation: only the tenant or admin/moderator may cancel
    const isTenant = booking.tenant_id === userId;
    const isAdmin = ['admin', 'moderator'].includes(userRole ?? '');
    if (!isTenant && !isAdmin) {
      return {
        success: false,
        error: 'Forbidden: only the tenant can cancel a booking',
        statusCode: 403,
      };
    }

    // 3. Eligibility: only Pending or Confirmed bookings may be cancelled by the tenant.
    //    Disputed bookings require admin resolution before cancellation.
    const status = booking.status ?? '';
    if (status === 'Disputed') {
      return {
        success: false,
        error: 'Cannot cancel a disputed booking. Resolve the dispute first.',
        statusCode: 409,
      };
    }

    // 4. Compute refund from the booking-time policy snapshot (#769).
    //    Falls back to the live policy if no snapshot exists (legacy bookings).
    let refund;

    const snapshotRefundResult = await computeRefundFromSnapshot(
      bookingId,
      booking.check_in ?? '',
      now,
    );

    if (snapshotRefundResult.success && snapshotRefundResult.data) {
      refund = snapshotRefundResult.data;
    } else {
      // Fallback: compute from the live policy (for legacy bookings without
      // a snapshot).
      try {
        refund = computeRefund({
          totalPrice: booking.total_price ?? 0,
          checkIn: booking.check_in ?? '',
          cancelledAt: now,
        });
      } catch (err) {
        return { success: false, error: `Cannot compute refund: ${String(err)}` };
      }
    }

    // Legacy bookings have no booking-time snapshot. Freeze the fallback terms
    // now so retries use the same policy calculation.
    if (!snapshotRefundResult.success && booking.total_price !== undefined) {
      const legacySnapshot = await createRefundSnapshot({
        bookingId,
        totalPrice: booking.total_price,
      });
      if (!legacySnapshot.success) {
        return { success: false, error: `Cannot persist refund terms: ${legacySnapshot.error}` };
      }
    }

    let refundRequestId: string | undefined;
    let refundRequestStatus: RefundStatus | undefined;
    if (refund.refundAmount > 0) {
      if (!hostId || !booking.tenant_id) {
        return { success: false, error: 'Cannot create refund request: booking participants could not be resolved' };
      }
      const refundRequestResult = await createRefundRequest({
        bookingId,
        tenantId: booking.tenant_id,
        hostId,
        cancelledAt: now,
        destinationEscrowId: booking.escrow_id ?? undefined,
      });
      if (!refundRequestResult.success || !refundRequestResult.data) {
        return {
          success: false,
          error: refundRequestResult.error ?? 'Failed to create recoverable refund request',
        };
      }
      refundRequestId = refundRequestResult.data.id;
      refundRequestStatus = refundRequestResult.data.status;
    }

    let refundWarning: string | undefined;
    // Partial refunds cannot be executed by the provider's all-or-nothing
    // escrow API. Keep those funds locked for operations rather than releasing
    // the full escrow and claiming a partial refund.
    if (refund.tier === 'partial' && refund.refundAmount > 0 && refundRequestId) {
      if (refundRequestStatus !== 'manual_review') {
        const reviewResult = await transitionRefundStatus(refundRequestId, 'manual_review', {
          errorMessage: 'Provider does not support partial escrow refunds; manual settlement required',
          actorId: userId,
        });
        if (!reviewResult.success) {
          return { success: false, error: reviewResult.error ?? 'Failed to route refund for manual review' };
        }
      }
      refundRequestStatus = 'manual_review';
      refundWarning = 'Your partial refund requires manual review; escrow funds remain locked.';
    } else if (refundRequestId && !booking.escrow_id) {
      if (refundRequestStatus !== 'manual_review') {
        const reviewResult = await transitionRefundStatus(refundRequestId, 'manual_review', {
          errorMessage: 'No escrow destination is available for refund settlement',
          actorId: userId,
        });
        if (!reviewResult.success) {
          return { success: false, error: reviewResult.error ?? 'Failed to route refund for manual review' };
        }
      }
      refundRequestStatus = 'manual_review';
      refundWarning = 'Your refund requires manual review because no escrow destination is available.';
    }

    // 5. Drive only escrow actions the provider can actually settle.
    if (booking.escrow_id) {
      loggingService.logBlockchainOperation('cancelEscrowRefund', {
        bookingId,
        userId,
        escrowId: booking.escrow_id,
        tier: refund.tier,
        refundAmount: refund.refundAmount,
      });

      try {
        if (refund.tier === 'full') {
          if (!refundRequestId) {
            return { success: false, error: 'Refund request is required before escrow cancellation' };
          }
          if (refundRequestStatus !== 'submitted' && refundRequestStatus !== 'confirmed') {
            const submitResult = await transitionRefundStatus(refundRequestId, 'submitted', { actorId: userId });
            if (!submitResult.success) {
              return { success: false, error: submitResult.error ?? 'Failed to submit refund request' };
            }
            refundRequestStatus = 'submitted';
          }

          if (refundRequestStatus !== 'confirmed') {
            const currentEscrow = await trustlessWorkClient.getEscrowStatus(booking.escrow_id);
            if (currentEscrow.status !== 'cancelled') {
              await trustlessWorkClient.cancelEscrow(booking.escrow_id);
            }

            const settledEscrow = await trustlessWorkClient.getEscrowStatus(booking.escrow_id);
            if (settledEscrow.status === 'cancelled') {
              const confirmedResult = await transitionRefundStatus(refundRequestId, 'confirmed', {
                actorId: userId,
              });
              if (!confirmedResult.success) {
                refundWarning = `Escrow was cancelled but refund confirmation is pending: ${confirmedResult.error}`;
              } else {
                refundRequestStatus = 'confirmed';
              }
            } else {
              refundWarning = 'Your refund was submitted and is awaiting escrow confirmation.';
            }
          }
        } else if (refund.refundAmount === 0) {
          const currentEscrow = await trustlessWorkClient.getEscrowStatus(booking.escrow_id);
          if (currentEscrow.status !== 'released') {
            await trustlessWorkClient.releaseEscrow(
              booking.escrow_id,
              'Booking cancelled with no eligible refund',
            );
          }
        } else if (refund.tier === 'partial') {
          // The escrow remains locked while the partial refund is reviewed.
        }
      } catch (err) {
        if (refundRequestId) {
          const failedResult = await transitionRefundStatus(refundRequestId, 'failed', {
            errorMessage: String(err),
            actorId: userId,
          });
          if (!failedResult.success) {
            console.error('[BookingService] Failed to persist refund failure state:', failedResult.error);
          }
        }
        loggingService.logBlockchainOperation(
          'cancelEscrowRefund',
          { bookingId, userId, escrowId: booking.escrow_id, tier: refund.tier },
          undefined,
          String(err),
        );
        return {
          success: false,
          error: `Failed to settle escrow: ${String(err)}`,
        };
      }
    }

    // 6. Persist the cancellation + refund outcome via the state machine.
    const cancelledAt = now.toISOString();
    const transitionResult = await this.transitionStatus(
      bookingId,
      status,
      'Cancelled',
      userId,
      `Cancelled by ${isTenant ? 'tenant' : 'admin/moderator'}`,
      {
        cancelled_at: cancelledAt,
        refund_amount: refund.refundAmount,
        refund_tier: refund.tier,
        refund_policy_pct: refund.refundPct,
      },
    );

    if (!transitionResult.success) return transitionResult;
    const updatedData = transitionResult.data!;

    // The Cancelled status is terminal and not in RESERVING_BOOKING_STATUSES,
    // so the exclusion constraint no longer covers this row: the dates are
    // released by the same UPDATE that flipped the status. This only happens
    // after the escrow/refund state above has been resolved, so a hold is never
    // freed while its payment outcome is still in flight.

    // 7. Notify both parties
    const notificationData = {
      booking_id: bookingId,
      refund_amount: refund.refundAmount,
      refund_tier: refund.tier,
      refund_policy_pct: refund.refundPct,
      refund_status: refundRequestStatus ?? (refund.refundAmount === 0 ? 'not_applicable' : 'requested'),
    };

    if (booking.tenant_id) {
      const queued = await enqueueNotificationOutbox(
        booking.tenant_id,
        'booking_cancelled',
        notificationData,
        `booking-cancelled:${bookingId}:tenant`,
      );
      if (!queued.success) {
        refundWarning ??= `Booking cancelled, but tenant notification could not be queued: ${queued.error}`;
      }
    }
    if (hostId) {
      const queued = await enqueueNotificationOutbox(
        hostId,
        'booking_cancelled',
        notificationData,
        `booking-cancelled:${bookingId}:host`,
      );
      if (!queued.success) {
        refundWarning ??= `Booking cancelled, but host notification could not be queued: ${queued.error}`;
      }
    }

    // 8. Update on-chain status (non-fatal)
    if (booking.on_chain_id !== undefined && booking.on_chain_id !== null) {
      const callerAddress = await fetchStellarAddress(userId);

      if (callerAddress) {
        loggingService.logBlockchainOperation('cancelBookingOnChain', {
          bookingId,
          userId,
        });

        try {
          await this.blockchain.cancelBookingOnChain(BigInt(booking.on_chain_id), callerAddress);
        } catch (err) {
          loggingService.logBlockchainOperation(
            'cancelBookingOnChain',
            {
              bookingId,
              userId,
            },
            undefined,
            String(err),
          );
          console.warn('[BookingService] On-chain cancellation failed:', err);
        }
      }
    }

    return { success: true, data: updatedData };
  }

  // ── Confirm ────────────────────────────────────────────────────────────────

  /**
   * Confirm a booking: release the escrow to the property owner, then update
   * DB and on-chain status to Confirmed.
   */
  async confirmBooking(bookingId: string, userId: string, userRole?: string): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties?: { owner_id: string } | null };

    // Authorization: only the host (property owner) or admin can confirm
    const hostId = booking.properties?.owner_id;
    if (!hostId || (hostId !== userId && !['admin', 'moderator'].includes(userRole ?? ''))) {
      return {
        success: false,
        error: 'Forbidden: only the host may confirm a booking',
        statusCode: 403,
      };
    }

    // Release escrow to owner
    if (booking.escrow_id) {
      loggingService.logBlockchainOperation('releaseEscrow', {
        bookingId,
        userId,
        escrowId: booking.escrow_id,
      });

      try {
        await trustlessWorkClient.releaseEscrow(booking.escrow_id, 'Booking confirmed by host');
      } catch (err) {
        loggingService.logBlockchainOperation(
          'releaseEscrow',
          { bookingId, userId, escrowId: booking.escrow_id },
          undefined,
          String(err),
        );
        return { success: false, error: `Failed to release escrow: ${String(err)}` };
      }
    }

    const transitionResult = await this.transitionStatus(
      bookingId,
      booking.status ?? 'Pending',
      'Confirmed',
      userId,
      'Confirmed by host',
    );
    if (!transitionResult.success) return transitionResult;

    // Notify tenant
    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'booking_confirmed', { booking_id: bookingId }).catch(
        () => {},
      );
    }

    // Update on-chain status (non-fatal)
    if (booking.on_chain_id !== undefined && booking.on_chain_id !== null) {
      const callerAddress = await fetchStellarAddress(userId);

      if (callerAddress) {
        loggingService.logBlockchainOperation('updateBookingStatusOnChain', { bookingId, userId });

        try {
          await this.blockchain.updateBookingStatusOnChain(
            BigInt(booking.on_chain_id),
            'Confirmed',
            callerAddress,
          );
        } catch (err) {
          loggingService.logBlockchainOperation(
            'updateBookingStatusOnChain',
            { bookingId, userId },
            undefined,
            String(err),
          );
          console.warn('[BookingService] On-chain status update failed:', err);
        }
      }
    }

    return { success: true, data: transitionResult.data! };
  }

  // ── Complete ───────────────────────────────────────────────────────────────

  /**
   * Mark a booking as Completed.
   *
   * Allowed transitions: Confirmed → Completed.
   * Only the tenant (or admin) may complete a booking. Completing releases the
   * escrow to the host if it hasn't been released yet, then marks the booking
   * Completed in the DB and on-chain.
   *
   * @param bookingId - UUID of the booking to complete
   * @param userId    - ID of the caller (must be the tenant)
   */
  async completeBooking(bookingId: string, userId: string, userRole?: string): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties: { owner_id: string } };

    // Authorisation: only the tenant or admin/moderator may mark as completed
    const isTenant = booking.tenant_id === userId;
    const isAdmin = ['admin', 'moderator'].includes(userRole ?? '');
    if (!isTenant && !isAdmin) {
      return {
        success: false,
        error: 'Forbidden: only the tenant can complete a booking',
        statusCode: 403,
      };
    }

    // Verify the provider settlement before recording host earnings. This is
    // idempotent because the ledger uses a booking-scoped source reference.
    if (booking.escrow_id) {
      loggingService.logBlockchainOperation('releaseEscrowComplete', {
        bookingId,
        userId,
        escrowId: booking.escrow_id,
      });

      try {
        const currentEscrow = await trustlessWorkClient.getEscrowStatus(booking.escrow_id);
        if (currentEscrow.status !== 'released') {
          await trustlessWorkClient.releaseEscrow(booking.escrow_id, 'Booking completed by tenant');
        }
        const settledEscrow = await trustlessWorkClient.getEscrowStatus(booking.escrow_id);
        if (settledEscrow.status !== 'released') {
          return { success: false, error: 'Escrow release is pending provider confirmation' };
        }
        const ledgerResult = await recordBookingSettlement(
          booking.properties.owner_id,
          bookingId,
          booking.total_price ?? 0,
        );
        if (!ledgerResult.success) {
          return { success: false, error: `Escrow was released but earnings ledger update failed: ${ledgerResult.error}` };
        }
      } catch (err) {
        loggingService.logBlockchainOperation(
          'releaseEscrowComplete',
          { bookingId, userId, escrowId: booking.escrow_id },
          undefined,
          String(err),
        );
        console.warn('[BookingService] Escrow release on complete failed:', err);
      }
    }

    const transitionResult = await this.transitionStatus(
      bookingId,
      booking.status ?? 'Confirmed',
      'Completed',
      userId,
      'Completed by tenant',
    );
    if (!transitionResult.success) return transitionResult;

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'booking_completed', { booking_id: bookingId }).catch(
        () => {},
      );
    }

    if (booking.on_chain_id !== undefined && booking.on_chain_id !== null) {
      const callerAddress = await fetchStellarAddress(userId);
      if (callerAddress) {
        loggingService.logBlockchainOperation('updateBookingStatusOnChain', {
          bookingId,
          userId,
          newStatus: 'Completed',
        });

        try {
          await this.blockchain.updateBookingStatusOnChain(
            BigInt(booking.on_chain_id),
            'Completed',
            callerAddress,
          );
        } catch (err) {
          loggingService.logBlockchainOperation(
            'updateBookingStatusOnChain',
            { bookingId, userId },
            undefined,
            String(err),
          );
          console.warn('[BookingService] On-chain complete status update failed:', err);
        }
      }
    }

    return { success: true, data: transitionResult.data! };
  }

  // ── Dispute ────────────────────────────────────────────────────────────────

  /**
   * Open a dispute on a booking.
   *
   * Allowed transitions: Confirmed → Disputed.
   * Only the tenant may open a dispute. The escrow is locked (not released)
   * until an admin resolves the dispute via resolveDispute().
   *
   * @param bookingId - UUID of the booking to dispute
   * @param userId    - ID of the caller (must be the tenant)
   * @param reason    - Optional human-readable reason for the dispute
   */
  async disputeBooking(
    bookingId: string,
    userId: string,
    reason?: string,
  ): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking;

    // Authorisation: only the tenant may raise a dispute
    if (booking.tenant_id && booking.tenant_id !== userId) {
      return { success: false, error: 'Forbidden: only the tenant can open a dispute' };
    }

    // Dispute on-chain (advisory — the DB transition is authoritative)
    if (booking.on_chain_id !== undefined && booking.on_chain_id !== null) {
      const callerAddress = await fetchStellarAddress(userId);
      if (callerAddress) {
        loggingService.logBlockchainOperation('disputeBookingOnChain', { bookingId, userId });
        try {
          const { disputeBookingOnChain } = await import('@/blockchain/bookingContract.js');
          await disputeBookingOnChain(callerAddress, BigInt(booking.on_chain_id));
        } catch (err) {
          loggingService.logBlockchainOperation(
            'disputeBookingOnChain',
            { bookingId, userId },
            undefined,
            String(err),
          );
          console.warn('[BookingService] On-chain dispute failed:', err);
        }
      }
    }

    const transitionResult = await this.transitionStatus(
      bookingId,
      booking.status ?? 'Confirmed',
      'Disputed',
      userId,
      reason,
      reason ? { dispute_reason: reason } : undefined,
    );
    if (!transitionResult.success) return transitionResult;

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'booking_disputed', { booking_id: bookingId }).catch(
        () => {},
      );
    }

    return { success: true, data: transitionResult.data! };
  }

  // ── Update / Delete ────────────────────────────────────────────────────────

  /**
   * Update mutable fields of an existing booking. Admin only, and audited.
   *
   * @param id - UUID of the booking
   * @param payload - Partial booking fields to update
   * @param actor - Authenticated caller; checked against the booking authorization matrix
   * @returns ServiceResponse with the updated booking
   * @throws Does not throw; errors are returned in the ServiceResponse
   */
  async updateBooking(
    id: string,
    payload: Partial<Booking>,
    actor: BookingActor,
  ): Promise<ServiceResponse<Booking>> {
    if (!id) {
      return { success: false, error: 'Booking ID is required' };
    }

    const decision = await bookingAuthorizationService.authorize('update', id, actor);
    if (!decision.allowed) {
      await this.auditBookingChange('booking.modify', id, actor, false, decision.reason);
      return { success: false, error: decision.reason, statusCode: decision.status };
    }

    if (Object.keys(payload).length === 0) {
      return { success: false, error: 'No fields provided for update' };
    }

    const { data, error } = await supabase
      .from('bookings')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      await this.auditBookingChange('booking.modify', id, actor, false, 'database update failed');
      return { success: false, error: error.message };
    }

    await this.auditBookingChange('booking.modify', id, actor, true);
    return { success: true, data: data as Booking };
  }

  /**
   * Permanently delete a booking record. Admin only, and audited.
   *
   * @param id - UUID of the booking to delete
   * @param actor - Authenticated caller; checked against the booking authorization matrix
   * @returns ServiceResponse with no data on success
   */
  async deleteBooking(id: string, actor: BookingActor): Promise<ServiceResponse<void>> {
    if (!id) {
      return { success: false, error: 'Booking ID is required' };
    }

    const decision = await bookingAuthorizationService.authorize('delete', id, actor);
    if (!decision.allowed) {
      await this.auditBookingChange('booking.delete', id, actor, false, decision.reason);
      return { success: false, error: decision.reason, statusCode: decision.status };
    }

    const { error } = await supabase.from('bookings').delete().eq('id', id);

    if (error) {
      await this.auditBookingChange('booking.delete', id, actor, false, 'database delete failed');
      return { success: false, error: error.message };
    }

    await this.auditBookingChange('booking.delete', id, actor, true);
    return { success: true };
  }

  /**
   * Fetch a booking on behalf of an authenticated caller. Non-participants
   * without a read role receive 404.
   *
   * @param bookingId - UUID of the booking
   * @param actor - Authenticated caller
   */
  async getBookingForActor(bookingId: string, actor: BookingActor): Promise<ServiceResponse<Booking>> {
    const decision = await bookingAuthorizationService.authorize('read', bookingId, actor);
    if (!decision.allowed) {
      return { success: false, error: decision.reason, statusCode: decision.status };
    }

    return this.getBookingById(bookingId);
  }

  /**
   * Fetch a booking's status history on behalf of an authenticated caller.
   *
   * @param bookingId - UUID of the booking
   * @param actor - Authenticated caller
   */
  async getBookingStatusHistoryForActor(
    bookingId: string,
    actor: BookingActor,
  ): Promise<ServiceResponse<BookingStatusHistory[]>> {
    const decision = await bookingAuthorizationService.authorize(
      'read_status_history',
      bookingId,
      actor,
    );
    if (!decision.allowed) {
      return { success: false, error: decision.reason, statusCode: decision.status };
    }

    return this.getBookingStatusHistory(bookingId);
  }

  /**
   * Record a booking change or a denied attempt. Never throws; the audit logger
   * is best-effort. Error text is limited to our own reasons, not database messages.
   */
  private async auditBookingChange(
    action: 'booking.modify' | 'booking.delete',
    bookingId: string,
    actor: BookingActor,
    success: boolean,
    error?: string,
  ): Promise<void> {
    await auditLogger.log({
      actorId: actor.id,
      action,
      resourceType: 'booking',
      resourceId: bookingId,
      success,
      error,
      meta: { actor_role: actor.role ?? null },
    });
  }

  // ── Dispute ────────────────────────────────────────────────────────────────

  /**
   * Raise a dispute on a booking. Only the tenant or host (property owner) may raise a dispute.
   *
   * @param bookingId - UUID of the booking
   * @param userId - UUID of the user raising the dispute
   * @param reason - Reason for the dispute
   * @param details - Optional additional details
   * @returns ServiceResponse with the updated booking
   */
  async raiseDispute(
    bookingId: string,
    userId: string,
    reason: string,
    details?: string
  ): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    // Fetch the booking
    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties: { owner_id: string } };
    const hostId = booking.properties.owner_id;

    // Authorization: only tenant or host may raise dispute
    if (booking.tenant_id !== userId && hostId !== userId) {
      return { success: false, error: 'Only the tenant or host may raise a dispute' };
    }

    if ((booking as unknown as { dispute_status?: string }).dispute_status === 'raised') {
      return { success: false, error: 'A dispute has already been raised for this booking' };
    }

    const transitionResult = await this.transitionStatus(
      bookingId,
      booking.status ?? 'Confirmed',
      'Disputed',
      userId,
      reason,
      { dispute_status: 'raised' },
    );
    if (!transitionResult.success) return transitionResult;

    const otherPartyId = booking.tenant_id === userId ? hostId : booking.tenant_id;

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'system_alert', {
        booking_id: bookingId,
        message: 'A dispute has been raised on your booking',
        reason,
      }).catch(() => {});
    }

    if (otherPartyId) {
      createNotification(otherPartyId, 'system_alert', {
        booking_id: bookingId,
        message: 'A dispute has been raised on a booking',
        reason,
      }).catch(() => {});
    }

    loggingService.logBlockchainOperation('raiseDispute', { bookingId, userId, reason });

    return { success: true, data: transitionResult.data! };
  }

  /**
   * Resolve a dispute on a booking. Only admins/moderators may resolve disputes.
   *
   * @param bookingId - UUID of the booking
   * @param userId - UUID of the admin resolving the dispute
   * @param resolution - 'refund_tenant' or 'release_to_host'
   * @param adminNotes - Optional admin notes
   * @returns ServiceResponse with the updated booking
   */
  async resolveDispute(
    bookingId: string,
    userId: string,
    resolution: 'refund_tenant' | 'release_to_host',
    adminNotes?: string,
    userRole?: string,
  ): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!userId) {
      return { success: false, error: 'User ID is required' };
    }

    // Authorization: only admin or moderator can resolve disputes
    if (!['admin', 'moderator'].includes(userRole ?? '')) {
      return {
        success: false,
        error: 'Forbidden: only admins or moderators may resolve disputes',
        statusCode: 403,
      };
    }

    // Fetch the booking
    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties: { owner_id: string } };

    if ((booking as unknown as { dispute_status?: string }).dispute_status !== 'raised') {
      return { success: false, error: 'No active dispute on this booking' };
    }

    // Handle escrow resolution
    if (booking.escrow_id) {
      loggingService.logBlockchainOperation('resolveDisputeEscrow', {
        bookingId,
        userId,
        resolution,
      });

      try {
        if (resolution === 'release_to_host') {
          await trustlessWorkClient.releaseEscrow(booking.escrow_id, `Dispute resolved: ${adminNotes ?? 'Released to host'}`);
        } else {
          await trustlessWorkClient.cancelEscrow(booking.escrow_id);
        }
      } catch (err) {
        loggingService.logBlockchainOperation(
          'resolveDisputeEscrow',
          { bookingId, userId, resolution },
          undefined,
          String(err)
        );
        return {
          success: false,
          error: `Failed to resolve escrow: ${String(err)}`,
        };
      }
    }

    const resolvedStatus = resolution === 'release_to_host' ? 'Completed' : 'Cancelled';
    const resolutionMessage =
      resolution === 'release_to_host'
        ? 'Dispute resolved in favor of host'
        : 'Dispute resolved in favor of tenant';

    const transitionResult = await this.transitionStatus(
      bookingId,
      'Disputed',
      resolvedStatus,
      userId,
      adminNotes ?? resolutionMessage,
      { dispute_status: 'resolved' },
    );
    if (!transitionResult.success) return transitionResult;

    const hostId = booking.properties.owner_id;

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'system_alert', {
        booking_id: bookingId,
        message: resolutionMessage,
      }).catch(() => {});
    }

    if (hostId) {
      createNotification(hostId, 'system_alert', {
        booking_id: bookingId,
        message: resolutionMessage,
      }).catch(() => {});
    }

    loggingService.logBlockchainOperation('resolveDispute', { bookingId, userId, resolution });

    return { success: true, data: transitionResult.data! };
  }

  // ── Modification Request ────────────────────────────────────────────────────

  /**
   * Request a date change for a booking.
   *
   * Allowed transitions: Confirmed or Pending → modification requested.
   * Only the booking tenant may request a modification.
   *
   * @param bookingId    - UUID of the booking
   * @param tenantId     - UUID of the caller (must be the tenant)
   * @param requestedStart - New requested check-in date (ISO 8601 date)
   * @param requestedEnd   - New requested check-out date (ISO 8601 date)
   * @param reason       - Optional reason for the date change
   * @returns ServiceResponse with the created modification record
   */
  async requestModification(
    bookingId: string,
    tenantId: string,
    requestedStart: string,
    requestedEnd: string,
    reason?: string,
    guestCount?: number,
  ): Promise<ServiceResponse<BookingModification>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!tenantId) {
      return { success: false, error: 'Tenant ID is required' };
    }

    const startDate = new Date(requestedStart);
    const endDate = new Date(requestedEnd);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return { success: false, error: 'requested_start and requested_end must be valid dates' };
    }

    if (startDate >= endDate) {
      return { success: false, error: 'requested_start must be before requested_end' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id, check_in_time, check_out_time, min_nights, max_nights, max_guests)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & {
      properties: {
        owner_id: string;
        check_in_time?: string;
        check_out_time?: string;
        min_nights?: number;
        max_nights?: number | null;
        max_guests?: number | null;
      };
    };

    if (booking.tenant_id !== tenantId) {
      return { success: false, error: 'Forbidden: only the tenant can request a modification' };
    }

    if (booking.status === 'Cancelled' || booking.status === 'Completed' || booking.status === 'Disputed') {
      return {
        success: false,
        error: `Cannot request modification for a booking in '${booking.status}' status`,
      };
    }

    if (!booking.check_in || !booking.check_out) {
      return { success: false, error: 'Booking is missing date information' };
    }

    const originalStart = new Date(booking.check_in);
    const originalEnd = new Date(booking.check_out);
    const nights = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));

    const minNights = booking.properties?.min_nights ?? 1;
    if (nights < minNights) {
      return {
        success: false,
        error: `This property requires a minimum stay of ${minNights} night${minNights === 1 ? '' : 's'} (requested: ${nights})`,
      };
    }

    const maxNights = booking.properties?.max_nights ?? null;
    if (maxNights !== null && maxNights !== undefined && nights > maxNights) {
      return {
        success: false,
        error: `This property allows a maximum stay of ${maxNights} night${maxNights === 1 ? '' : 's'} (requested: ${nights})`,
      };
    }

    // Guest-count validation (only when the caller requests an occupancy change)
    if (guestCount !== undefined && guestCount !== null) {
      if (!Number.isFinite(guestCount) || !Number.isInteger(guestCount) || guestCount < 1) {
        return { success: false, error: 'guest_count must be a positive integer' };
      }
      const maxGuests = booking.properties?.max_guests;
      if (maxGuests !== undefined && maxGuests !== null && guestCount > maxGuests) {
        return {
          success: false,
          error: `Guest count (${guestCount}) exceeds property capacity (${maxGuests})`,
        };
      }
    }

    if (booking.properties?.check_in_time && booking.properties?.check_out_time) {
      const { data: sameDayBooking } = await supabase
        .from('bookings')
        .select('id')
        .eq('property_id', booking.property_id)
        .eq('check_out', requestedStart)
        .neq('status', 'Cancelled')
        .neq('id', bookingId)
        .maybeSingle();

      if (sameDayBooking && booking.properties.check_out_time >= booking.properties.check_in_time) {
        return {
          success: false,
          error: `Same-day check-in is not available for the requested dates`,
        };
      }
    }

    const availabilityResult = await checkDateRangeAvailability(booking.property_id!, requestedStart, requestedEnd, bookingId);
    if (!availabilityResult.success || !availabilityResult.data?.is_available) {
      return {
        success: false,
        error: availabilityResult.data?.unavailable_reason ?? 'Requested dates are not available',
        conflict: true,
      };
    }

    // Capture an immutable snapshot of the booking before any changes are made.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { properties: _props, ...bookingSnapshot } = booking as Booking & { properties?: unknown };

    const { data: modification, error: insertError } = await supabase
      .from('booking_modifications')
      .insert({
        booking_id: bookingId,
        requested_start: requestedStart,
        requested_end: requestedEnd,
        original_start: booking.check_in,
        original_end: booking.check_out,
        status: 'pending',
        requested_by: tenantId,
        reason: reason ?? null,
        original_total_price: booking.total_price ?? null,
        booking_snapshot: bookingSnapshot as Record<string, unknown>,
        // Proposals the host never acts on must not linger indefinitely —
        // give the host a bounded window to approve/decline before the
        // proposal auto-expires (see expireStaleModifications).
        expires_at: new Date(Date.now() + MODIFICATION_PROPOSAL_TTL_MS).toISOString(),
      })
      .select()
      .single();

    if (insertError || !modification) {
      return { success: false, error: insertError?.message ?? 'Failed to create modification request' };
    }

    if (booking.properties?.owner_id) {
      createNotification(booking.properties.owner_id, 'booking_modification_requested', {
        booking_id: bookingId,
        modification_id: modification.id,
        requested_start: requestedStart,
        requested_end: requestedEnd,
        tenant_id: tenantId,
      }).catch(() => {});
    }

    return { success: true, data: modification as BookingModification };
  }

  /**
   * Accept a date-change request for a booking.
   *
   * Only the property owner (host) may accept a modification.
   * Re-validates availability and recomputes pricing before updating.
   *
   * @param bookingId     - UUID of the booking
   * @param hostId        - UUID of the caller (must be the host)
   * @param modificationId - UUID of the modification request
   * @returns ServiceResponse with the updated booking
   */
  async acceptModification(
    bookingId: string,
    hostId: string,
    modificationId: string,
  ): Promise<ServiceResponse<Booking>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!modificationId) {
      return { success: false, error: 'Modification ID is required' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id, base_price_per_night)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & {
      properties: { owner_id: string; base_price_per_night: number };
    };

    if (booking.properties.owner_id !== hostId) {
      return { success: false, error: 'Forbidden: only the host can accept a modification' };
    }

    const { data: modificationData, error: modError } = await supabase
      .from('booking_modifications')
      .select('*')
      .eq('id', modificationId)
      .eq('booking_id', bookingId)
      .single();

    if (modError || !modificationData) {
      return { success: false, error: 'Modification request not found' };
    }

    const modification = modificationData as BookingModification;

    if (isLazilyExpiredModification(modification)) {
      return {
        success: false,
        error: 'This modification proposal has expired — the original booking is unchanged',
        conflict: true,
        statusCode: 409,
        code: 'MODIFICATION_EXPIRED',
      };
    }

    if (modification.status !== 'pending') {
      return {
        success: false,
        error: `Modification is already ${modification.status}`,
      };
    }

    const availabilityResult = await checkDateRangeAvailability(
      booking.property_id!,
      modification.requested_start,
      modification.requested_end,
      bookingId,
    );
    if (!availabilityResult.success || !availabilityResult.data?.is_available) {
      return {
        success: false,
        error: availabilityResult.data?.unavailable_reason ?? 'Requested dates are no longer available',
        conflict: true,
      };
    }

    const priceResult = await calculateRangePrice(
      booking.property_id!,
      modification.requested_start,
      modification.requested_end,
    );
    if (!priceResult.success) {
      return { success: false, error: priceResult.error ?? 'Failed to recompute price' };
    }

    const newTotalPrice = Math.round(priceResult.data!.total * 100) / 100;
    const originalPrice = modification.original_total_price ?? booking.total_price ?? 0;
    const priceDelta = Math.round((newTotalPrice - originalPrice) * 100) / 100;
    const requiresAdditionalPayment = priceDelta > 0;

    const bookingPatch: Record<string, unknown> = {
      check_in:    modification.requested_start,
      check_out:   modification.requested_end,
      total_price: newTotalPrice,
      updated_at:  new Date().toISOString(),
    };

    // Apply occupancy change if the modification included one
    if (modification.requested_guest_count !== undefined && modification.requested_guest_count !== null) {
      bookingPatch.guest_count = modification.requested_guest_count;
    }

    // Apply the date change and mark the proposal accepted in one transaction.
    // The RPC re-checks availability under a per-property advisory lock and
    // writes under the exclusion constraint, so a competing booking or
    // modification that claimed the interval after the preflight read above
    // cannot slip through. On conflict the whole transaction rolls back and
    // the proposal stays pending.
    const { data: updatedBooking, error: updateError } = await supabase.rpc(
      'accept_booking_modification_atomic',
      {
        p_booking_id: bookingId,
        p_modification_id: modificationId,
        p_check_in: modification.requested_start,
        p_check_out: modification.requested_end,
        p_total_price: newTotalPrice,
        p_guest_count:
          modification.requested_guest_count !== undefined &&
          modification.requested_guest_count !== null
            ? modification.requested_guest_count
            : null,
        p_new_total_price: newTotalPrice,
        p_price_delta: priceDelta,
        p_requires_additional_payment: requiresAdditionalPayment,
      },
    );

    if (updateError || !updatedBooking) {
      // The exclusion constraint is the authoritative, transactional guard against
      // overlapping active bookings. `checkDateRangeAvailability` above is only a
      // preflight read — another booking (or another accepted modification) may
      // have claimed the requested interval in the gap between that check and this
      // write. Translate that into the same stable, tenant-safe 409 used elsewhere,
      // never the raw Postgres error (which can echo constraint/row internals).
      if (isExclusionViolation(updateError)) {
        return dateConflictResponse();
      }
      const msg = updateError?.message ?? '';
      if (msg.includes('BOOKING_CONFLICT')) {
        return dateConflictResponse();
      }
      if (msg.includes('MODIFICATION_NOT_PENDING')) {
        return {
          success: false,
          error: 'This modification proposal is no longer pending',
          conflict: true,
          statusCode: 409,
          code: 'MODIFICATION_NOT_PENDING',
        };
      }
      return { success: false, error: updateError?.message ?? 'Failed to update booking dates' };
    }

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'booking_modification_accepted', {
        booking_id: bookingId,
        modification_id: modificationId,
        requested_start: modification.requested_start,
        requested_end: modification.requested_end,
        original_total_price: originalPrice,
        new_total_price: newTotalPrice,
        price_delta: priceDelta,
        requires_additional_payment: requiresAdditionalPayment,
      }).catch(() => {});
    }

    return { success: true, data: updatedBooking as Booking };
  }

  /**
   * Decline a date-change request for a booking.
   *
   * Only the property owner (host) may decline a modification.
   *
   * @param bookingId     - UUID of the booking
   * @param hostId        - UUID of the caller (must be the host)
   * @param modificationId - UUID of the modification request
   * @returns ServiceResponse with the declined modification record
   */
  async declineModification(
    bookingId: string,
    hostId: string,
    modificationId: string,
  ): Promise<ServiceResponse<BookingModification>> {
    if (!bookingId) {
      return { success: false, error: 'Booking ID is required' };
    }

    if (!modificationId) {
      return { success: false, error: 'Modification ID is required' };
    }

    const { data: bookingData, error: fetchError } = await supabase
      .from('bookings')
      .select('*, properties!inner(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !bookingData) {
      return { success: false, error: 'Booking not found' };
    }

    const booking = bookingData as Booking & { properties: { owner_id: string } };

    if (booking.properties.owner_id !== hostId) {
      return { success: false, error: 'Forbidden: only the host can decline a modification' };
    }

    const { data: modificationData, error: modError } = await supabase
      .from('booking_modifications')
      .select('*')
      .eq('id', modificationId)
      .eq('booking_id', bookingId)
      .single();

    if (modError || !modificationData) {
      return { success: false, error: 'Modification request not found' };
    }

    const modification = modificationData as BookingModification;

    if (isLazilyExpiredModification(modification)) {
      return {
        success: false,
        error: 'This modification proposal has expired — the original booking is unchanged',
        conflict: true,
        statusCode: 409,
        code: 'MODIFICATION_EXPIRED',
      };
    }

    if (modification.status !== 'pending') {
      return {
        success: false,
        error: `Modification is already ${modification.status}`,
      };
    }

    // Condition the decline on the proposal still being pending so a decline
    // racing an accept (or the expiry sweep) cannot clobber the winner.
    const { data: updatedModification, error: updateError } = await supabase
      .from('booking_modifications')
      .update({ status: 'declined', updated_at: new Date().toISOString() })
      .eq('id', modificationId)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (updateError) {
      return { success: false, error: updateError.message };
    }
    if (!updatedModification) {
      return {
        success: false,
        error: 'This modification proposal is no longer pending',
        conflict: true,
        statusCode: 409,
        code: 'MODIFICATION_NOT_PENDING',
      };
    }

    if (booking.tenant_id) {
      createNotification(booking.tenant_id, 'booking_modification_declined', {
        booking_id: bookingId,
        modification_id: modificationId,
        requested_start: modification.requested_start,
        requested_end: modification.requested_end,
      }).catch(() => {});
    }

    return { success: true, data: updatedModification as BookingModification };
  }
}
