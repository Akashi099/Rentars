/**
 * Unit tests for deterministic search ordering (issue #749).
 */

import { describe, expect, it } from 'bun:test';
import { buildSearchOrderClauses, compareSearchRows } from '../../src/utils/searchSort.js';

const SORTS = ['price_asc', 'price_desc', 'rating', 'relevance', 'distance', 'newest'];

describe('buildSearchOrderClauses', () => {
  it.each(SORTS)('always ends %s with the unique id column', (sortBy) => {
    const clauses = buildSearchOrderClauses(sortBy);
    expect(clauses[clauses.length - 1]).toEqual({ column: 'id', options: { ascending: true } });
  });

  it('defaults unknown and missing sort keys to newest first', () => {
    expect(buildSearchOrderClauses(undefined)).toEqual(buildSearchOrderClauses('newest'));
    expect(buildSearchOrderClauses('not-a-sort')).toEqual(buildSearchOrderClauses('newest'));
    expect(buildSearchOrderClauses('newest')).toEqual([
      { column: 'created_at', options: { ascending: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('sorts price ascending and descending on price_per_night', () => {
    expect(buildSearchOrderClauses('price_asc')[0]).toEqual({
      column: 'price_per_night',
      options: { ascending: true },
    });
    expect(buildSearchOrderClauses('price_desc')[0]).toEqual({
      column: 'price_per_night',
      options: { ascending: false },
    });
  });

  it('orders by rating then review count, keeping unrated listings last', () => {
    expect(buildSearchOrderClauses('rating')).toEqual([
      { column: 'average_rating', options: { ascending: false, nullsFirst: false } },
      { column: 'review_count', options: { ascending: false, nullsFirst: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('never repeats the id clause or places it before the primary sort key', () => {
    for (const sortBy of SORTS) {
      const columns = buildSearchOrderClauses(sortBy).map((c) => c.column);
      expect(columns.filter((c) => c === 'id')).toHaveLength(1);
      expect(columns.indexOf('id')).toBe(columns.length - 1);
    }
  });

  it('produces the same clause list for the same input (deterministic)', () => {
    for (const sortBy of SORTS) {
      expect(buildSearchOrderClauses(sortBy)).toEqual(buildSearchOrderClauses(sortBy));
    }
  });
});

/**
 * Simulated pagination over a fixture with many tied sort keys. Using the
 * clauses above as a comparator must yield pages that together contain every
 * row exactly once, which is the property issue #749 requires.
 */
describe('stable pagination with tied sort keys', () => {
  type Row = {
    id: string;
    price_per_night: number;
    average_rating: number | null;
    review_count: number | null;
    created_at: string;
  };

  // Fixture matrix: ties on price and rating, plus unrated listings with null
  // ratings and review counts, so nulls and equal keys are both exercised.
  const rows: Row[] = Array.from({ length: 23 }, (_, i) => ({
    id: `listing-${String(i).padStart(2, '0')}`,
    price_per_night: 100 + (i % 4) * 10,
    average_rating: i % 5 === 0 ? null : 3 + (i % 3),
    review_count: i % 5 === 0 ? null : i % 2,
    created_at: `2026-01-${String((i % 3) + 1).padStart(2, '0')}T00:00:00Z`,
  }));

  function pageAll(input: Row[], sortBy: string, pageSize: number): string[] {
    const ordered = [...input].sort((a, b) =>
      compareSearchRows(a, b, buildSearchOrderClauses(sortBy))
    );
    const seen: string[] = [];
    for (let from = 0; from < ordered.length; from += pageSize) {
      seen.push(...ordered.slice(from, from + pageSize).map((r) => r.id));
    }
    return seen;
  }

  it.each(['price_asc', 'price_desc', 'rating', 'newest'])(
    'pages %s without duplicates or skipped rows',
    (sortBy) => {
      for (const pageSize of [1, 5, 7]) {
        const seen = pageAll(rows, sortBy, pageSize);
        expect(new Set(seen).size).toBe(rows.length);
        expect([...seen].sort()).toEqual(rows.map((r) => r.id).sort());
      }
    }
  );

  it('keeps the same order no matter how the input is shuffled', () => {
    const reversed = [...rows].reverse();
    expect(pageAll(reversed, 'rating', 4)).toEqual(pageAll(rows, 'rating', 4));
  });

  it('places unrated listings last when sorting by rating', () => {
    const ordered = [...rows].sort((a, b) =>
      compareSearchRows(a, b, buildSearchOrderClauses('rating'))
    );
    const firstNullIndex = ordered.findIndex((r) => r.average_rating === null);
    expect(firstNullIndex).toBeGreaterThan(0);
    expect(ordered.slice(firstNullIndex).every((r) => r.average_rating === null)).toBe(true);
  });
});

describe('compareSearchRows null handling', () => {
  const clauses = [{ column: 'v', options: { ascending: true } }];

  it('sorts nulls last for ascending by default (Postgres default)', () => {
    const ordered = [{ v: null }, { v: 2 }, { v: 1 }].sort((a, b) =>
      compareSearchRows(a, b, clauses)
    );
    expect(ordered.map((r) => r.v)).toEqual([1, 2, null]);
  });

  it('honours an explicit nullsFirst option', () => {
    const first = [{ column: 'v', options: { ascending: false, nullsFirst: true } }];
    const ordered = [{ v: 1 }, { v: null }, { v: 2 }].sort((a, b) =>
      compareSearchRows(a, b, first)
    );
    expect(ordered.map((r) => r.v)).toEqual([null, 2, 1]);
  });
});
