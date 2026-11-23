/** Canonical profile as returned by GET /api/profile (owner view) (#918). */
export interface UserProfile {
  user_id: string;
  name?: string | null;
  avatar_url?: string | null;
  phone?: string | null;
  bio?: string | null;
  stellar_address?: string | null;
  verification_status?: 'unverified' | 'verified';
  created_at?: string;
  updated_at?: string;
  completeness?: { score: number; maxScore: number; missingFields: string[] };
}

/** Fields the profile form can send. Omitted keys are left unchanged on the server. */
export interface ProfileUpdateData {
  name?: string;
  phone?: string | null;
  avatar_url?: string | null;
  stellar_address?: string | null;
  expected_updated_at?: string;
}

/**
 * Shared typed async-state pattern for data-driven surfaces (#998).
 *
 * Distinguishes initial loading, background refresh, empty results, and
 * recoverable/unrecoverable failures so consumers never present default or
 * stale data as a confirmed successful response.
 */
export type AsyncStatus = 'idle' | 'loading' | 'refreshing' | 'success' | 'error';

/** Recoverable failures can be retried by the user; unrecoverable ones cannot. */
export type AsyncErrorKind = 'recoverable' | 'unrecoverable';

export interface AsyncError {
  kind: AsyncErrorKind;
  message: string;
  /** Optional HTTP status or error code for diagnostics. */
  code?: string | number;
}

export interface AsyncState<T> {
  status: AsyncStatus;
  /** Confirmed data from the last successful response; null until first success. */
  data: T | null;
  error: AsyncError | null;
  /** True when data is present but a refresh is in flight (stale data shown). */
  isStale: boolean;
  /** Timestamp (ms) of the last confirmed successful response. */
  lastUpdatedAt: number | null;
}

/** Discriminated union form of the async state for exhaustive handling. */
export type AsyncStateUnion<T> =
  | { status: 'idle'; data: null; error: null; isStale: false; lastUpdatedAt: null }
  | { status: 'loading'; data: null; error: null; isStale: false; lastUpdatedAt: null }
  | { status: 'refreshing'; data: T; error: null; isStale: true; lastUpdatedAt: number }
  | { status: 'success'; data: T; error: null; isStale: false; lastUpdatedAt: number }
  | { status: 'error'; data: T | null; error: AsyncError; isStale: boolean; lastUpdatedAt: number | null };

/** Profile-specific aliases for the shared async-state pattern. */
export type ProfileAsyncState = AsyncState<UserProfile>;
export type ProfileAsyncStateUnion = AsyncStateUnion<UserProfile>;

/** Initial state for a profile data hook. */
export const initialProfileAsyncState: ProfileAsyncState = {
  status: 'idle',
  data: null,
  error: null,
  isStale: false,
  lastUpdatedAt: null,
};