/**
 * Combined-filter and ordering edge cases for property search (issue #749).
 *
 * Covers the pure re-ordering step applied after the database returns rows:
 * featured promotion must keep every matched listing exactly once, respect the
 * cap, and stay deterministic when weights tie.
 */

import { describe, expect, it } from 'bun:test';
import { promoteFeatureToTop } from '../../src/services/propertySearch.service.js';
import type { Property } from '../../src/services/property.service.js';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

function listing(id: string, overrides: Partial<Property> = {}): Property {
  return { id, title: id, ...overrides } as Property;
}

describe('promoteFeatureToTop', () => {
  const fixture: Property[] = [
    listing('a'),
    listing('b', { featured_until: FUTURE, featured_weight: 5 }),
    listing('c', { featured_until: PAST, featured_weight: 9 }),
    listing('d', { featured_until: FUTURE, featured_weight: 5 }),
    listing('e', { featured_until: FUTURE, featured_weight: 8 }),
    listing('f'),
  ];

  it('keeps every input listing exactly once', () => {
    const out = promoteFeatureToTop(fixture);
    expect(out.map((p) => p.id).sort()).toEqual(fixture.map((p) => p.id).sort());
  });

  it('orders currently featured listings by weight, then id, regardless of input order', () => {
    const forward = promoteFeatureToTop(fixture).map((p) => p.id);
    const backward = promoteFeatureToTop([...fixture].reverse()).map((p) => p.id);

    expect(forward.slice(0, 3)).toEqual(['e', 'b', 'd']);
    expect(backward.slice(0, 3)).toEqual(['e', 'b', 'd']);
  });

  it('marks promoted listings and never flags organic ones as featured', () => {
    const out = promoteFeatureToTop(fixture);
    const flagged = out.filter((p) => p.is_featured).map((p) => p.id);
    expect(flagged).toEqual(['e', 'b', 'd']);
  });

  it('demotes overflow past the cap to organic results instead of dropping them', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      listing(`f-${String(i).padStart(2, '0')}`, { featured_until: FUTURE, featured_weight: i })
    );
    const out = promoteFeatureToTop(many, 3);

    expect(out).toHaveLength(many.length);
    expect(out.filter((p) => p.is_featured)).toHaveLength(3);
    expect(out.slice(0, 3).map((p) => p.id)).toEqual(['f-11', 'f-10', 'f-09']);
  });

  it('pages through the promoted order without duplicates or skipped listings', () => {
    const ordered = promoteFeatureToTop(fixture).map((p) => p.id);
    const pageSize = 2;
    const seen: string[] = [];
    for (let from = 0; from < ordered.length; from += pageSize) {
      seen.push(...ordered.slice(from, from + pageSize));
    }
    expect(seen).toEqual(ordered);
    expect(new Set(seen).size).toBe(fixture.length);
  });
});
