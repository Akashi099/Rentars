// ─── Booking status ───────────────────────────────────────────────────────────

/**
 * All valid booking status values.
 *
 * DB stores title-case (Pending, Confirmed, …) but the frontend normalises
 * everything to lowercase for comparisons so both forms are included.
 */
export type BookingStatus =
  | 'Pending'   | 'pending'
  | 'Confirmed' | 'confirmed'
  | 'Completed' | 'completed'
  | 'Cancelled' | 'cancelled'
  | 'Disputed'  | 'disputed'
  | 'escrow_reconcile_failed';

/** Normalise a raw status string from the API to lowercase. */
export function normaliseStatus(status: string): Lowercase<BookingStatus> {
  return status.toLowerCase() as Lowercase<BookingStatus>;
}

// ─── Semantic status tokens ──────────────────────────────────────────────────

/**
 * Semantic status categories shared by badges, alerts and blockchain status
 * components. These map onto the shared design tokens (success, warning,
 * error, pending, focus) so state is never communicated by color alone.
 */
export type SemanticStatus =
  | 'success'
  | 'warning'
  | 'error'
  | 'pending'
  | 'neutral';

/** Human-readable label for each semantic status (used alongside icons). */
export const SEMANTIC_STATUS_LABELS: Record<SemanticStatus, string> = {
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  pending: 'Pending',
  neutral: 'Neutral',
};

/**
 * Map a booking status to its semantic status category. Unknown or
 * reconciliation-failure states fall back to `error` so they are never
 * presented as a confirmed success.
 */
export function bookingStatusToSemantic(status: string): SemanticStatus {
  switch (normaliseStatus(status)) {
    case 'confirmed':
    case 'completed':
      return 'success';
    case 'pending':
      return 'pending';
    case 'disputed':
    case 'escrow_reconcile_failed':
      return 'error';
    case 'cancelled':
      return 'neutral';
    default:
      return 'warning';
  }
}

// ─── Async state ─────────────────────────────────────────────────────────────

/**
 * Typed async state used by data hooks (booking history, notifications,
 * wishlists, analytics, search). Distinguishes initial loading from
 * background refresh and never represents stale data as confirmed success.
 */
export type AsyncState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T; isStale: boolean; refreshedAt: string | null }
  | { status: 'error'; error: Error; isRecoverable: boolean; previousData: T | null };

/** Metadata describing a refresh of already-loaded data. */
export interface RefreshMeta {
  /** True while a background refresh is in flight over existing data. */
  isRefreshing: boolean;
  /** ISO timestamp of the last confirmed successful response. */
  refreshedAt: string | null;
  /** True when the displayed data predates the latest successful fetch. */
  isStale: boolean;
}

/** Initial async state before any request has been made. */
export const IDLE_ASYNC_STATE: AsyncState<never> = { status: 'idle' };

// ─── Allowed lifecycle transitions ───────────────────────────────────────────

/**
 * Valid transitions the current user (tenant) may trigger from each state.
 * Mirrors the server-side state machine.
 */
export const TENANT_TRANSITIONS: Record<string, ('confirm' | 'complete' | 'cancel' | 'dispute')[]> = {
  pending:   ['cancel'],
  confirmed: ['complete', 'dispute', 'cancel'],
  completed: [],
  cancelled: [],
  disputed:  [],
};

// ─── Payment / transaction status ────────────────────────────────────────────

/**
 * Explicit Stellar payment lifecycle states.
 *
 * - `submitted`  — broadcast acknowledged by the provider, not yet in a ledger.
 * - `pending`    — accepted by the network, awaiting ledger inclusion.
 * - `confirmed`  — included in a ledger (final success).
 * - `failed`     — final failure; safe to retry.
 * - `ambiguous`  — outcome unknown (e.g. polling timeout); must go through
 *                  reconciliation, never a blind retry.
 */
export type PaymentStatus =
  | 'submitted'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';

/** Stellar networks the app can operate on. */
export type StellarNetwork = 'mainnet' | 'testnet';

/** Statuses after which a broadcast must not be retried blindly. */
export const NON_RETRYABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'submitted',
  'pending',
  'confirmed',
  'ambiguous',
];

/** True when the payment reached a final, successful ledger state. */
export function isPaymentConfirmed(status?: PaymentStatus | null): boolean {
  return status === 'confirmed';
}

/** True when a retry is safe (final failure only). */
export function isPaymentRetryable(status?: PaymentStatus | null): boolean {
  return status === 'failed';
}

/** True when the outcome is unresolved and needs reconciliation. */
export function isPaymentAmbiguous(status?: PaymentStatus | null): boolean {
  return status === 'ambiguous';
}

// ─── Core types ───────────────────────────────────────────────────────────────

// ─── Monetary precision & currency conversion ────────────────────────────────

/**
 * Rounding modes supported by the backend conversion helpers.
 * Mirrors the server-side enum so quotes can disclose their rounding behaviour.
 */
export type RoundingMode = 'half_up' | 'half_even' | 'floor' | 'ceil';

/**
 * Snapshot of a converted display amount attached to a quote/booking.
 *
 * `display_amount` is a decimal string in the display currency's minor units
 * (never a binary float) so the UI, API and DB agree on the exact amount.
 */
export interface DisplayCurrencySnapshot {
  /** ISO 4217 code (or 'USDC') of the currency shown to the user. */
  display_currency: string;
  /** Decimal string of the converted amount in display-currency minor units. */
  display_amount: string;
  /** Decimal string of the original amount in its source minor units. */
  original_amount?: string;
  /** Currency the original amount is denominated in. */
  original_currency?: string;
  /** Decimal places supported for `display_currency`. */
  display_decimals?: number;
  /** Identifier of the rate source (e.g. provider name). */
  rate_source?: string;
  /** Unix epoch milliseconds when the rate was fetched. */
  rate_timestamp_ms?: number;
  /** True when the rate is older than the configured freshness window. */
  rate_stale?: boolean;
  /** Rounding mode applied during conversion. */
  rounding_mode?: RoundingMode;
}

// ─── Payment timeline ────────────────────────────────────────────────────────

/**
 * Canonical payment timeline states, derived from the payment ledger.
 * Provider processing states are distinct from final ledger confirmation.
 */
export type PaymentTimelineStatus =
  | 'quote_created'
  | 'payment_submitted'
  | 'provider_processing'
  | 'ledger_confirmed'
  | 'settled'
  | 'refunded'
  | 'failed'
  | 'pending';

/** Terminal timeline states — polling must stop once reached. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentTimelineStatus[] = [
  'ledger_confirmed',
  'settled',
  'refunded',
  'failed',
] as const;

export function isTerminalPaymentStatus(status: PaymentTimelineStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

/** A single entry in the payment timeline. */
export interface PaymentTimelineEvent {
  /** Stable identifier for the event (ledger entry id). */
  id: string;
  status: PaymentTimelineStatus;
  /** Human-readable label safe for display to booking participants. */
  label: string;
  /** ISO 8601 timestamp of when the event occurred. */
  occurred_at: string;
  /** True when this event is the current/latest state. */
  current?: boolean;
  /** True when the event represents a terminal state. */
  terminal?: boolean;
  /** Optional safe next step for pending/failed states. */
  next_step?: string | null;
  /** Optional amount snapshot associated with the event. */
  amount?: DisplayCurrencySnapshot;
}

/** Full timeline payload returned by the payment timeline API. */
export interface PaymentTimeline {
  booking_id: string;
  events: PaymentTimelineEvent[];
  /** Latest status, convenience mirror of the last event. */
  status: PaymentTimelineStatus;
  /** True when no further updates are expected. */
  terminal: boolean;
  /** Rate/conversion details for support and user-facing disclosure. */
  rate_source?: string;
  rate_timestamp_ms?: number;
  rate_stale?: boolean;
  rounding_mode?: RoundingMode;
}

// ─── Core types ───────────────────────────────────────────────────────────────

export interface Booking {
  id: string;
  property_id: string;
  tenant_id: string;
  check_in: string;
  check_out: string;
  guest_count: number;
  total_price: number;
  status: BookingStatus;
  escrow_id?: string;
  escrow_status?: 'locked' | 'released' | 'refunded' | 'pending' | 'manual_review';
  on_chain_id?: number;
  /** Stellar network the escrow/payment was created on. */
  network?: StellarNetwork;
  /** Transaction hash of the escrow/payment broadcast. */
  tx_hash?: string | null;
  /** Explicit payment lifecycle state for UI status + retry guidance. */
  payment_status?: PaymentStatus;
  rules_acknowledged_at?: string | null;
  dispute_reason?: string | null;
  created_at: string;
  updated_at?: string;
  /** Converted display amount snapshot; absent when no conversion applies. */
  display?: DisplayCurrencySnapshot;
  display_currency?: string;
  display_amount?: string;
  rate_timestamp_ms?: number;
  rate_stale?: boolean;
}

export interface BookingFormData {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  propertyId: string;
}

export interface BookingWithProperty extends Booking {
  property?: {
    id: string;
    title: string;
    city?: string;
    country?: string;
    address?: string;
    images?: string[];
    slug?: string;
    owner_id?: string;
  };
}
