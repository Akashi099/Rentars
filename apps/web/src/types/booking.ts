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
  rules_acknowledged_at?: string | null;
  dispute_reason?: string | null;
  created_at: string;
  updated_at?: string;
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
