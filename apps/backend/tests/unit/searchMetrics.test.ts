/**
 * Unit tests for search instrumentation helpers (issue #750).
 */

import { describe, expect, it } from 'bun:test';
import {
  SLOW_QUERY_THRESHOLD_MS,
  cacheHitRate,
  hashSearchQuery,
  isSlowQuery,
  percentile,
  toBoundedLabel,
} from '../../src/utils/searchMetrics.js';

describe('hashSearchQuery', () => {
  it('is deterministic and prefixed', () => {
    const hash = hashSearchQuery('lagos flat');
    expect(hash).toMatch(/^q_[0-9a-f]{16}$/);
    expect(hashSearchQuery('lagos flat')).toBe(hash);
  });

  it('normalises case, surrounding whitespace and internal spacing', () => {
    expect(hashSearchQuery('  Lagos   FLAT ')).toBe(hashSearchQuery('lagos flat'));
  });

  it('distinguishes different terms', () => {
    expect(hashSearchQuery('lagos flat')).not.toBe(hashSearchQuery('abuja flat'));
  });

  it('does not contain the raw search term', () => {
    const term = 'secret-downtown-address';
    expect(hashSearchQuery(term)).not.toContain('secret');
    expect(hashSearchQuery(term)).not.toContain('downtown');
  });
});

describe('percentile', () => {
  it('returns 0 for an empty list', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('uses nearest-rank selection', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile(values, 0)).toBe(10);
  });

  it('does not depend on input order and does not mutate the input', () => {
    const values = [90, 10, 50];
    expect(percentile(values, 50)).toBe(50);
    expect(values).toEqual([90, 10, 50]);
  });

  it('clamps out-of-range percentiles', () => {
    expect(percentile([1, 2, 3], 150)).toBe(3);
    expect(percentile([1, 2, 3], -5)).toBe(1);
  });
});

describe('cacheHitRate', () => {
  it('computes the hit fraction', () => {
    expect(cacheHitRate(3, 1)).toBe(0.75);
  });

  it('returns 0 when there were no lookups rather than NaN', () => {
    expect(cacheHitRate(0, 0)).toBe(0);
  });
});

describe('isSlowQuery', () => {
  it('flags durations strictly above the threshold', () => {
    expect(isSlowQuery(SLOW_QUERY_THRESHOLD_MS + 1)).toBe(true);
    expect(isSlowQuery(SLOW_QUERY_THRESHOLD_MS)).toBe(false);
    expect(isSlowQuery(12)).toBe(false);
  });

  it('ignores non-finite durations', () => {
    expect(isSlowQuery(Number.NaN)).toBe(false);
    expect(isSlowQuery(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('honours an explicit threshold', () => {
    expect(isSlowQuery(120, 100)).toBe(true);
  });
});

describe('toBoundedLabel', () => {
  const endpoints = ['search', 'nearby', 'suggest'] as const;

  it('keeps values from the allowed set', () => {
    expect(toBoundedLabel('nearby', endpoints)).toBe('nearby');
  });

  it('collapses unexpected values to the fallback so cardinality stays bounded', () => {
    expect(toBoundedLabel('/search/q_abc123', endpoints)).toBe('other');
    expect(toBoundedLabel('nearby', endpoints, 'suggest')).toBe('nearby');
    expect(toBoundedLabel('unknown-route', endpoints, 'suggest')).toBe('suggest');
  });
});
