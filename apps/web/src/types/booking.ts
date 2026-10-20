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
  | 'Disputed'  | 'disputed';

/** Normalise a raw status string from the API to lowercase. */
export function normaliseStatus(status: string): Lowercase<BookingStatus> {
  return status.toLowerCase() as Lowercase<BookingStatus>;
}

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
  escrow_status?: 'locked' | 'released' | 'refunded';
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

// ─── Payment error taxonomy ──────────────────────────────────────────────────

/**
 * Internal payment error categories. Each maps to a distinct user-facing
 * message and a distinct set of safe recovery actions.
 */
export type PaymentErrorCategory =
  | 'wallet_rejected'
  | 'insufficient_funds'
  | 'rpc_failure'
  | 'provider_timeout'
  | 'contract_rejection'
  | 'unknown';

/**
 * Transaction status at the time the error occurred. Used to decide which
 * recovery actions are safe — e.g. a signed transaction must never be
 * resubmitted.
 */
export type PaymentTransactionStatus =
  | 'unsigned'
  | 'signed'
  | 'submitted'
  | 'confirmed'
  | 'failed';

/** Actions the UI may offer for a recoverable payment failure. */
export type PaymentRecoveryAction =
  | 'retry'
  | 'change_wallet'
  | 'cancel'
  | 'contact_support';

/**
 * Recoverable payment failure state. `message` is safe for display and never
 * contains secrets or implies success. `idempotencyKey` preserves context so
 * a retry cannot duplicate a payment.
 */
export interface PaymentErrorState {
  category: PaymentErrorCategory;
  /** Safe, user-facing message. */
  message: string;
  /** Actions that are safe for the current transaction status. */
  allowedActions: PaymentRecoveryAction[];
  transactionStatus: PaymentTransactionStatus;
  /** Idempotency context retained across retries. */
  idempotencyKey?: string;
  /** Whether the failure can be recovered without support intervention. */
  recoverable: boolean;
}
