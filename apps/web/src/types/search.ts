/** Shared types for search — used by usePropertySearch and FilterSidebar. */

export interface PriceHistogramBucket {
  /** Lower bound of this bucket (inclusive). */
  min: number;
  /** Upper bound of this bucket (exclusive, except the last bucket). */
  max: number;
  /** Number of listings in this bucket. */
  count: number;
}

export interface PriceHistogramResult {
  buckets: PriceHistogramBucket[];
  /** Lowest price across all listings in current context (price filter excluded). */
  global_min: number;
  /** Highest price across all listings in current context (price filter excluded). */
  global_max: number;
}

/**
 * Shared typed async-state model for data-driven hooks and pages.
 *
 * Distinguishes initial loading, refresh, empty results, and errors so that
 * components never present default or stale data as a confirmed success.
 */

/** Lifecycle status of an async data source. */
export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

/** Metadata describing a recoverable failure and how to retry it. */
export interface AsyncError {
  /** Human-readable message safe to display to users. */
  message: string;
  /** Optional machine-readable error code (e.g. HTTP status or API code). */
  code?: string;
  /** Whether the failure can be retried by the user. */
  recoverable: boolean;
  /** Number of consecutive failed attempts so far. */
  attempt: number;
  /** Timestamp (ms since epoch) of the most recent failure. */
  failedAt: number;
}

/** Initial loading state — no data has been fetched yet. */
export interface AsyncIdleState {
  status: 'idle';
  data: undefined;
  error: undefined;
  /** True while a request is in flight. */
  isLoading: false;
  /** True during a background refresh that keeps previous data visible. */
  isRefreshing: false;
  /** True when the last successful response was empty. */
  isEmpty: false;
  /** True when displayed data comes from a previous successful response. */
  isStale: false;
}

/** Loading state — a request is in flight and no confirmed data exists yet. */
export interface AsyncLoadingState<T> {
  status: 'loading';
  data: undefined;
  error: undefined;
  isLoading: true;
  isRefreshing: false;
  isEmpty: false;
  isStale: false;
}

/** Success state — a confirmed response was received (possibly empty). */
export interface AsyncSuccessState<T> {
  status: 'success';
  data: T;
  error: undefined;
  isLoading: false;
  isRefreshing: false;
  /** True when the confirmed response contains no results. */
  isEmpty: boolean;
  /** True when this data is being shown while a refresh is in flight. */
  isStale: boolean;
}

/** Error state — the request failed; data may be stale or absent. */
export interface AsyncErrorState<T> {
  status: 'error';
  /** Last confirmed data, if any (never presented as a fresh success). */
  data: T | undefined;
  error: AsyncError;
  isLoading: false;
  isRefreshing: false;
  isEmpty: false;
  /** True when `data` is from a previous successful response. */
  isStale: boolean;
}

/** Discriminated union of all async states. */
export type AsyncState<T> =
  | AsyncIdleState
  | AsyncLoadingState<T>
  | AsyncSuccessState<T>
  | AsyncErrorState<T>;

/** Options for retrying a recoverable failure. */
export interface AsyncRetryOptions {
  /** Force a full reload instead of a background refresh. */
  force?: boolean;
}

/** Retry control exposed by the reusable async-state hook. */
export interface AsyncRetry {
  /** Whether the current error (if any) can be retried. */
  canRetry: boolean;
  /** Trigger a retry of the failed request. */
  retry: (options?: AsyncRetryOptions) => void;
}

/** Predicate used to decide whether a successful response is empty. */
export type AsyncEmptyPredicate<T> = (data: T) => boolean;
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>