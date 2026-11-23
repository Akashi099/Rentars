export interface PropertyImage {
  id: string;
  url: string;
  is_primary?: boolean;
  display_order?: number;
}

export interface Property {
  id: string;
  title: string;
  description: string;
  price_per_night: number;
  location: string;
  images: PropertyImage[];
  owner_id: string;
  available: boolean;
  created_at: string;

  // Capacity
  max_guests?: number;

  // Map search support
  lat?: number;
  lng?: number;

  // Featured listing window (migration 00022).
  // A property is currently featured when featured_until is a future datetime.
  // The backend also surfaces is_featured: true on search results so the
  // frontend never needs to parse the timestamp itself.
  featured_until?: string | null;
  is_featured?: boolean;

  // Human-readable URL slug (migration 00024).
  // Format: <title>-<city>-<6-char-id-prefix>
  slug?: string;
}

/**
 * Build the canonical URL path for a property.
 *
 * Prefer the slug when available (SEO-friendly), fall back to the UUID
 * for backwards-compatibility with properties that pre-date migration 00024.
 *
 * @example
 *   propertyPath({ id: 'abc', slug: 'cozy-loft-paris-a1b2c3' })
 *   // → '/property/cozy-loft-paris-a1b2c3'
 *
 *   propertyPath({ id: 'abc' })
 *   // → '/property/abc'
 */
export function propertyPath(property: Pick<Property, 'id' | 'slug'>): string {
  return `/property/${property.slug ?? property.id}`;
}

/**
 * Shared typed async-state pattern for data-driven surfaces.
 *
 * Distinguishes initial loading, refresh (stale data present), success,
 * empty (no data), and error (with optional recoverability) so that
 * components never present default or stale data as a confirmed success.
 */
export type AsyncStatus = 'idle' | 'loading' | 'refreshing' | 'success' | 'empty' | 'error';

/**
 * A recoverable error carries a retry affordance; non-recoverable errors
 * (e.g. 404 / not-found) should be surfaced without a retry control.
 */
export interface AsyncError {
  message: string;
  /** Whether the failure can be retried by the user. */
  recoverable: boolean;
  /** Optional machine-readable code (e.g. HTTP status or API error code). */
  code?: string | number;
  /** Optional underlying cause for logging/debugging. */
  cause?: unknown;
}

/**
 * Discriminated union describing the state of an async data fetch.
 *
 * - `idle` / `loading`: no confirmed data yet.
 * - `refreshing`: previous data is present but a new request is in flight;
 *   consumers must treat `data` as stale, not confirmed.
 * - `success`: confirmed data present.
 * - `empty`: request succeeded but returned no data.
 * - `error`: request failed; `data` (if present) is stale and must not be
 *   presented as a confirmed successful response.
 */
export type AsyncState<T> =
  | { status: 'idle'; data: undefined; error: undefined }
  | { status: 'loading'; data: undefined; error: undefined }
  | { status: 'refreshing'; data: T; error: undefined }
  | { status: 'success'; data: T; error: undefined }
  | { status: 'empty'; data: undefined; error: undefined }
  | { status: 'error'; data: T | undefined; error: AsyncError };

/**
 * Property detail loading/error/empty state, built on the shared pattern.
 */
export type PropertyDetailState = AsyncState<Property>;

/** Convenience guards for narrowing the shared async state. */
export function isAsyncLoading<T>(state: AsyncState<T>): boolean {
  return state.status === 'idle' || state.status === 'loading';
}

export function isAsyncRefreshing<T>(state: AsyncState<T>): boolean {
  return state.status === 'refreshing';
}

export function isAsyncSuccess<T>(state: AsyncState<T>): state is Extract<AsyncState<T>, { status: 'success' }> {
  return state.status === 'success';
}

export function isAsyncEmpty<T>(state: AsyncState<T>): boolean {
  return state.status === 'empty';
}

export function isAsyncError<T>(state: AsyncState<T>): state is Extract<AsyncState<T>, { status: 'error' }> {
  return state.status === 'error';
}

/** True when the error is recoverable and a retry control should be shown. */
export function isRetryableError<T>(state: AsyncState<T>): boolean {
  return state.status === 'error' && state.error.recoverable;
}