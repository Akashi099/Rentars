/**
 * Helpers for search instrumentation (issue #750).
 *
 * Privacy: raw search terms are hashed before they are persisted, and hashes
 * must never be used as metric labels because they are unbounded. Metric
 * labels come from fixed sets via `toBoundedLabel`.
 */

import { createHash } from 'node:crypto';

/** Queries slower than this are flagged as slow for operator review. */
export const SLOW_QUERY_THRESHOLD_MS = 500;

/**
 * Hash a search term for storage. Input is normalised (trimmed, lower-cased,
 * whitespace collapsed) so that "Lagos  flat" and "lagos flat" share one
 * identifier, which keeps analytics useful without keeping the term itself.
 */
export function hashSearchQuery(query: string): string {
  const normalised = query.trim().toLowerCase().replace(/\s+/g, ' ');
  return `q_${createHash('sha256').update(normalised).digest('hex').slice(0, 16)}`;
}

/**
 * Nearest-rank percentile of a list of numbers. Returns 0 for an empty list so
 * dashboards show a flat zero instead of NaN.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const clamped = Math.min(Math.max(p, 0), 100);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((clamped / 100) * sorted.length);
  return sorted[Math.max(rank - 1, 0)];
}

/** Cache hit rate in [0, 1]. Returns 0 when there were no lookups. */
export function cacheHitRate(hits: number, misses: number): number {
  const total = hits + misses;
  return total === 0 ? 0 : hits / total;
}

export function isSlowQuery(durationMs: number, thresholdMs = SLOW_QUERY_THRESHOLD_MS): boolean {
  return Number.isFinite(durationMs) && durationMs > thresholdMs;
}

/**
 * Map a value onto a fixed label set. Anything outside the set becomes
 * `fallback`, so label cardinality is bounded by the size of `allowed`.
 */
export function toBoundedLabel<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T | 'other' = 'other'
): T | 'other' {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
