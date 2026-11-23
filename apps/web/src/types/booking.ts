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
