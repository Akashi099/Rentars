/**
 * #926: explainable, bounded dynamic pricing.
 *
 * Covers rule precedence and overlap refusal, invalid and non-finite multipliers,
 * cent-exact totals, out-of-policy rejection, quote changes when a relevant rule
 * changes (including through a signed token), and the price explanation per night.
 */
import { describe, expect, it, mock } from 'bun:test';
import {
  findOverlappingRule,
  isNightlyPriceOutOfPolicy,
  isValidMultiplier,
  nightlyPriceCents,
  ruleForNight,
  sortRules,
  toCents,
} from '../../src/utils/pricingRules.js';
import {
  type FakeSupabase,
  createFakeSupabase,
  currentFakeSupabase,
  useFakeSupabase,
} from './helpers/fakeSupabase';

// Quote tokens are only issued when a signing secret is configured.
process.env.QUOTE_SIGNING_SECRET = 'test-secret-for-listing-pricing';

mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (table: string) => currentFakeSupabase().from(table),
  },
}));
mock.module('../../src/services/cache.service.js', () => ({
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  invalidatePattern: async () => undefined,
}));

// Isolated instance: other specs mock these services process-wide.
const pricing = await import('../../src/services/pricing.service.ts?pricing-spec');

const PROP = 'prop-1';
const OWNER = 'owner-1';

function install(f: FakeSupabase): FakeSupabase {
  useFakeSupabase(f);
  return f;
}

function listing(base: number, extra: Record<string, unknown[]> = {}) {
  return createFakeSupabase({
    properties: [
      {
        id: PROP,
        owner_id: OWNER,
        base_price_per_night: base,
        updated_at: '2026-01-01T00:00:00Z',
        status: 'available',
        draft_status: null,
        deleted_at: null,
        moderation_state: 'visible',
        max_guests: 4,
      },
    ],
    bookings: [],
    availability_ranges: [],
    seasonal_pricing: [],
    special_events: [],
    ...extra,
  });
}

// ─── Pure rules ───────────────────────────────────────────────────────────────

describe('multipliers', () => {
  it.each([
    [0.1, true],
    [10, true],
    [1.5, true],
    [0.09, false],
    [10.01, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    ['2' as unknown as number, false],
  ])('isValidMultiplier(%p) is %p', (value, expected) => {
    expect(isValidMultiplier(value)).toBe(expected);
  });
});

describe('precedence', () => {
  const rules = [
    {
      id: 'r-late',
      name: 'Late',
      start_date: '2026-07-10',
      end_date: '2026-07-20',
      price_multiplier: 3,
    },
    {
      id: 'r-early-b',
      name: 'Early B',
      start_date: '2026-07-05',
      end_date: '2026-07-15',
      price_multiplier: 2,
    },
    {
      id: 'r-early-a',
      name: 'Early A',
      start_date: '2026-07-05',
      end_date: '2026-07-15',
      price_multiplier: 1.5,
    },
  ];

  it('picks the earliest start, then the lowest id, for an overlapping night', () => {
    expect(ruleForNight(rules, '2026-07-12')?.id).toBe('r-early-a');
    expect(sortRules(rules).map((r) => r.id)).toEqual(['r-early-a', 'r-early-b', 'r-late']);
  });

  it('gives the same answer regardless of input order', () => {
    expect(ruleForNight([...rules].reverse(), '2026-07-12')?.id).toBe('r-early-a');
  });

  it('treats the end date as exclusive', () => {
    expect(ruleForNight(rules, '2026-07-15')?.id).toBe('r-late');
    expect(ruleForNight(rules, '2026-07-20')).toBeUndefined();
  });

  it('does not flag adjacent rules as overlapping', () => {
    // "Late" ends on 20 July (exclusive), so a rule starting that day is adjacent.
    const adjacent = { start_date: '2026-07-20', end_date: '2026-07-25' };
    expect(findOverlappingRule(adjacent, rules)).toBeUndefined();
    expect(
      findOverlappingRule({ start_date: '2026-07-14', end_date: '2026-07-16' }, rules)?.id
    ).toBe('r-early-a');
  });
});

describe('cents and policy bounds', () => {
  it('rounds each night to cents', () => {
    expect(toCents(36.663)).toBe(3666);
    expect(nightlyPriceCents(33.33, [1.1])).toBe(3666);
  });

  it('returns null for non-finite inputs, which are out of policy', () => {
    expect(nightlyPriceCents(Number.NaN, [1])).toBeNull();
    expect(isNightlyPriceOutOfPolicy(null)).toBe(true);
  });

  it('bounds nightly prices to [$1, $10,000]', () => {
    expect(isNightlyPriceOutOfPolicy(99)).toBe(true);
    expect(isNightlyPriceOutOfPolicy(100)).toBe(false);
    expect(isNightlyPriceOutOfPolicy(1_000_000)).toBe(false);
    expect(isNightlyPriceOutOfPolicy(1_000_001)).toBe(true);
  });
});

// ─── Rule creation ────────────────────────────────────────────────────────────

describe('creating seasonal rules', () => {
  it('refuses a rule that overlaps an existing one and names it', async () => {
    install(
      listing(100, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Summer',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_multiplier: 1.5,
          },
        ],
      })
    );
    const r = await pricing.createSeasonalPricing(PROP, OWNER, {
      name: 'Festival',
      start_date: '2026-07-20',
      end_date: '2026-07-25',
      price_multiplier: 2,
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('RULE_OVERLAP');
    expect(r.statusCode).toBe(409);
    expect(r.error).toContain('Summer');
  });

  it('accepts a rule that starts on the day the previous one ends', async () => {
    install(
      listing(100, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Summer',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_multiplier: 1.5,
          },
        ],
      })
    );
    const r = await pricing.createSeasonalPricing(PROP, OWNER, {
      name: 'Late summer',
      start_date: '2026-08-01',
      end_date: '2026-08-10',
      price_multiplier: 1.2,
    });
    expect(r.success).toBe(true);
  });

  it('refuses a NaN multiplier, which the old range check let through', async () => {
    install(listing(100));
    const r = await pricing.createSeasonalPricing(PROP, OWNER, {
      name: 'Broken',
      start_date: '2026-07-01',
      end_date: '2026-07-05',
      price_multiplier: Number.NaN,
    });
    expect(r.success).toBe(false);
    expect(r.code).toBe('INVALID_MULTIPLIER');
  });

  it('refuses an unparseable date', async () => {
    install(listing(100));
    const r = await pricing.createSeasonalPricing(PROP, OWNER, {
      name: 'Bad date',
      start_date: 'not-a-date',
      end_date: '2026-07-05',
      price_multiplier: 1.2,
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/valid dates/);
  });
});

describe('creating special events', () => {
  it('refuses a priced event that overlaps another priced event', async () => {
    install(
      listing(100, {
        special_events: [
          {
            id: 'e1',
            property_id: PROP,
            name: 'Marathon',
            start_date: '2026-09-01',
            end_date: '2026-09-05',
            price_multiplier: 1.4,
            is_blocked: false,
          },
        ],
      })
    );
    const r = await pricing.createSpecialEvent(PROP, OWNER, {
      name: 'Concert',
      start_date: '2026-09-03',
      end_date: '2026-09-04',
      price_multiplier: 1.8,
      is_blocked: false,
    });
    expect(r.code).toBe('RULE_OVERLAP');
  });

  it('allows a block to overlap a priced event, because a block wins', async () => {
    install(
      listing(100, {
        special_events: [
          {
            id: 'e1',
            property_id: PROP,
            name: 'Marathon',
            start_date: '2026-09-01',
            end_date: '2026-09-05',
            price_multiplier: 1.4,
            is_blocked: false,
          },
        ],
      })
    );
    const r = await pricing.createSpecialEvent(PROP, OWNER, {
      name: 'Repairs',
      start_date: '2026-09-02',
      end_date: '2026-09-03',
      is_blocked: true,
    });
    expect(r.success).toBe(true);
  });
});

// ─── Quotes ───────────────────────────────────────────────────────────────────

describe('calculateRangePrice — nightly rules', () => {
  it('applies a seasonal rule to its nights only, with an exclusive end date', async () => {
    install(
      listing(100, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Peak',
            start_date: '2026-07-10',
            end_date: '2026-07-12',
            price_multiplier: 2,
          },
        ],
      })
    );
    const r = await pricing.calculateRangePrice(PROP, '2026-07-09', '2026-07-13');
    expect(r.data?.breakdown.map((d) => d.price)).toEqual([100, 200, 200, 100]);
    expect(r.data?.total).toBe(600);
    expect(r.data?.breakdown[1].applied_rules?.[0]).toMatchObject({
      kind: 'seasonal',
      id: 's1',
      multiplier: 2,
    });
    expect(r.data?.breakdown[0].applied_rules).toEqual([]);
  });

  it('marks a night out of policy instead of clamping it', async () => {
    install(listing(0.5));
    const r = await pricing.previewPricing(PROP, '2026-07-01', '2026-07-02');
    expect(r.data?.breakdown[0].price).toBe(0.5);
    expect(r.data?.breakdown[0].out_of_policy).toBe(true);
  });
});

describe('getPropertyQuote — cent-exact totals and policy', () => {
  it('sums whole cents and reports the platform fee in cents', async () => {
    install(
      listing(33.33, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Shoulder',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_multiplier: 1.1,
          },
        ],
      })
    );
    const r = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-13');
    expect(r.success).toBe(true);
    const q = r.data!;
    expect(q.nights).toBe(3);
    expect(q.subtotal).toBe(99.99); // base rate × nights, at base
    expect(q.dynamic_adjustments).toBe(9.99); // 3 × $36.66 − $99.99
    expect(q.platform_fee).toBe(5.5); // 5% of $109.98 = $5.499, rounded to $5.50
    expect(q.total).toBe(115.48);
    expect(q.pricing_version).toBe('pv1');
  });

  it('rejects a stay with an out-of-policy night and names the night and rules', async () => {
    install(
      listing(9000, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Surge',
            start_date: '2026-07-01',
            end_date: '2026-08-01',
            price_multiplier: 2,
          },
        ],
      })
    );
    const r = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-11');
    expect(r.success).toBe(false);
    expect(r.code).toBe('PRICE_OUT_OF_POLICY');
    expect(r.statusCode).toBe(422);
    const details = r.details as {
      nights: Array<{ date: string; rules: Array<{ name: string }> }>;
    };
    expect(details.nights[0].date).toBe('2026-07-10');
    expect(details.nights[0].rules[0].name).toBe('Surge');
  });

  it('rejects a rate below the minimum', async () => {
    install(listing(0.5));
    const r = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-11');
    expect(r.code).toBe('PRICE_OUT_OF_POLICY');
  });

  it('changes the fingerprint when a rule that affects the stay changes', async () => {
    const fake = install(listing(100));
    const before = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');

    fake.tables.seasonal_pricing.push({
      id: 's-new',
      property_id: PROP,
      name: 'New peak',
      start_date: '2026-07-10',
      end_date: '2026-07-11',
      price_multiplier: 1.5,
    });
    const after = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');

    expect(before.data?.pricing_fingerprint).toBeDefined();
    expect(after.data?.pricing_fingerprint).not.toBe(before.data?.pricing_fingerprint);
    expect(after.data?.total).not.toBe(before.data?.total);
  });

  it('keeps the fingerprint when a rule outside the stay changes', async () => {
    const fake = install(listing(100));
    const before = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');

    fake.tables.seasonal_pricing.push({
      id: 's-far',
      property_id: PROP,
      name: 'Winter',
      start_date: '2026-12-01',
      end_date: '2026-12-10',
      price_multiplier: 1.5,
    });
    const after = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');

    expect(after.data?.pricing_fingerprint).toBe(before.data?.pricing_fingerprint);
  });

  it('refuses a signed quote token after a relevant rule changes', async () => {
    const fake = install(listing(100));
    const quoted = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');
    const token = quoted.data!.quote_token!;
    expect(token).toBeTruthy();

    fake.tables.seasonal_pricing.push({
      id: 's-new',
      property_id: PROP,
      name: 'Surprise',
      start_date: '2026-07-10',
      end_date: '2026-07-11',
      price_multiplier: 1.5,
    });

    const check = await pricing.assertQuotedTotal({
      propertyId: PROP,
      checkIn: '2026-07-10',
      checkOut: '2026-07-12',
      clientTotal: quoted.data!.total,
      quoteToken: token,
    });
    expect(check.success).toBe(false);
    expect(check.code).toBe('PRICE_CHANGED');
  });

  it('accepts the same quote token while nothing relevant has changed', async () => {
    install(listing(100));
    const quoted = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');
    const check = await pricing.assertQuotedTotal({
      propertyId: PROP,
      checkIn: '2026-07-10',
      checkOut: '2026-07-12',
      clientTotal: quoted.data!.total,
      quoteToken: quoted.data!.quote_token!,
    });
    expect(check.success).toBe(true);
  });
});

describe('pricingSnapshotFromQuote — explainable booking record', () => {
  it('records the nightly line items and the rules that set them', async () => {
    install(
      listing(100, {
        seasonal_pricing: [
          {
            id: 's1',
            property_id: PROP,
            name: 'Peak',
            start_date: '2026-07-10',
            end_date: '2026-07-11',
            price_multiplier: 2,
          },
        ],
      })
    );
    const quoted = await pricing.getPropertyQuote(PROP, '2026-07-10', '2026-07-12');
    const snapshot = pricing.pricingSnapshotFromQuote(quoted.data!) as {
      nightly: Array<{ date: string; price: number; applied_rules: Array<{ name: string }> }>;
      total: number;
      version: string;
    };
    expect(snapshot.version).toBe('pv1');
    expect(snapshot.total).toBe(quoted.data!.total);
    expect(snapshot.nightly.map((n) => n.price)).toEqual([200, 100]);
    expect(snapshot.nightly[0].applied_rules[0].name).toBe('Peak');
    expect(snapshot.nightly[1].applied_rules).toEqual([]);
  });
});
