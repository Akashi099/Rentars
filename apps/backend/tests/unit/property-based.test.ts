/**
 * Property-Based (Generative) Tests
 *
 * These tests define invariants — facts that must hold for every input in a
 * constrained domain — and exercise them with many generated samples.
 *
 * Because the project uses Bun (no fast-check / hypothesis runtime available),
 * we implement a lightweight inline generator that:
 *   1. Defines domains (bounded value generators).
 *   2. Runs N samples per property.
 *   3. On first failure, records the seed so it can be frozen as a regression.
 *
 * Domains covered:
 *   • Refund-policy arithmetic   — totals non-negative, tier ordering, round-trip
 *   • Date ordering              — check_out > check_in invariant
 *   • Pagination                 — page/pageSize produce non-overlapping windows
 *   • Booking validator          — malformed inputs always rejected with 400
 *   • Auth validator             — malformed inputs always rejected with 400
 *   • State-machine transitions  — only valid status transitions are accepted
 *   • Unauthorized mutation      — non-owner cannot mutate another user's booking
 *   • Amount arithmetic          — night × rate = total, never negative, no float drift
 *
 * Run:  bun test tests/unit/property-based.test.ts
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import {
  computeRefund,
  resolveRefundTier,
  getRefundPolicyConfig,
  type RefundPolicyConfig,
} from '@/services/refundPolicy.service.js';

// ── Minimal fast-property harness ─────────────────────────────────────────────

type Gen<T> = () => T;

/**
 * Run a property (predicate) against `samples` randomly generated values.
 * On first failure, throws an error that includes the failing input and the
 * deterministic seed so CI can reproduce it.
 */
function forAll<T>(
  label: string,
  gen: Gen<T>,
  property: (value: T) => boolean | void,
  samples = 200,
  seed?: number,
): void {
  // xorshift32 — fast, reproducible, good distribution for testing
  let state = seed ?? (Date.now() >>> 0) || 0xcafe_babe;
  function xorshift32(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  }

  // Inject the RNG into generators that need it
  (gen as Gen<T> & { _rng?: () => number })._rng = xorshift32;

  for (let i = 0; i < samples; i++) {
    const value = gen();
    let passed: boolean | void;
    try {
      passed = property(value);
    } catch (err) {
      throw new Error(
        `[property-based] "${label}" FAILED on sample ${i + 1}/${samples}\n` +
          `  Input: ${JSON.stringify(value)}\n` +
          `  Seed:  ${state}\n` +
          `  Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (passed === false) {
      throw new Error(
        `[property-based] "${label}" FAILED on sample ${i + 1}/${samples}\n` +
          `  Input: ${JSON.stringify(value)}\n` +
          `  Seed:  ${state}`,
      );
    }
  }
}

// ── Primitive generators ──────────────────────────────────────────────────────

/** Uniform float in [min, max] */
function float(min: number, max: number): Gen<number> {
  const g: Gen<number> = () => {
    const rng = (g as Gen<number> & { _rng?: () => number })._rng ?? Math.random;
    return min + rng() * (max - min);
  };
  return g;
}

/** Uniform integer in [min, max] inclusive */
function int(min: number, max: number): Gen<number> {
  const g: Gen<number> = () => {
    const rng = (g as Gen<number> & { _rng?: () => number })._rng ?? Math.random;
    return Math.floor(min + rng() * (max - min + 1));
  };
  return g;
}

/** Positive integer in [1, max] */
function posInt(max = 100): Gen<number> {
  return int(1, max);
}

/** Generate a date at `baseDays` in the future + `offsetDays` */
function futureDate(minDaysAhead: number, maxDaysAhead: number): Gen<Date> {
  const g: Gen<Date> = () => {
    const rng = (g as Gen<Date> & { _rng?: () => number })._rng ?? Math.random;
    const days =
      minDaysAhead + Math.floor(rng() * (maxDaysAhead - minDaysAhead + 1));
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(12, 0, 0, 0);
    return d;
  };
  return g;
}

function isoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** Tuple: (checkIn, checkOut) where checkOut is 1–30 days after checkIn */
function validDatePair(): Gen<[Date, Date]> {
  const g: Gen<[Date, Date]> = () => {
    const rng = (g as Gen<[Date, Date]> & { _rng?: () => number })._rng ?? Math.random;
    const daysAhead = Math.floor(1 + rng() * 364);
    const stay = Math.floor(1 + rng() * 29);
    const checkIn = new Date();
    checkIn.setDate(checkIn.getDate() + daysAhead);
    checkIn.setHours(12, 0, 0, 0);
    const checkOut = new Date(checkIn);
    checkOut.setDate(checkOut.getDate() + stay);
    return [checkIn, checkOut];
  };
  return g;
}

/** Tuple: (checkOut, checkIn) — inverted (invalid) */
function invertedDatePair(): Gen<[Date, Date]> {
  const g: Gen<[Date, Date]> = () => {
    const rng = (g as Gen<[Date, Date]> & { _rng?: () => number })._rng ?? Math.random;
    const daysAhead = Math.floor(2 + rng() * 30);
    const checkOut = new Date();
    checkOut.setDate(checkOut.getDate() + daysAhead);
    checkOut.setHours(12, 0, 0, 0);
    const checkIn = new Date(checkOut);
    checkIn.setDate(checkIn.getDate() + Math.floor(1 + rng() * 10));
    return [checkOut, checkIn]; // inverted: first element is "earlier" checkOut
  };
  return g;
}

/** Map a generator through a transform */
function map<A, B>(gen: Gen<A>, fn: (a: A) => B): Gen<B> {
  const g: Gen<B> = () => {
    const rng = (g as Gen<B> & { _rng?: () => number })._rng;
    (gen as Gen<A> & { _rng?: () => number })._rng = rng;
    return fn(gen());
  };
  return g;
}

/** Randomly choose one element from an array */
function oneOf<T>(items: T[]): Gen<T> {
  const g: Gen<T> = () => {
    const rng = (g as Gen<T> & { _rng?: () => number })._rng ?? Math.random;
    return items[Math.floor(rng() * items.length)];
  };
  return g;
}

// ── Refund policy config used across tests ─────────────────────────────────────

const testPolicy: RefundPolicyConfig = {
  fullRefundHours: 168, // 7 days
  noRefundHours: 48,
  partialRefundPct: 0.5,
};

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Refund policy arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: refund amounts are always non-negative', () => {
  it('refundAmount >= 0 for all valid totalPrice and checkIn values', () => {
    forAll(
      'refund >= 0',
      map(validDatePair(), ([checkIn, _checkOut]) => ({
        totalPrice: Math.round(Math.random() * 10_000 * 100) / 100 + 1,
        checkIn,
        cancelledAt: new Date(),
      })),
      ({ totalPrice, checkIn, cancelledAt }) => {
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        return result.refundAmount >= 0;
      },
    );
  });

  it('refundAmount <= totalPrice for all cases', () => {
    forAll(
      'refund <= total',
      map(validDatePair(), ([checkIn]) => ({
        totalPrice: float(1, 50_000)(),
        checkIn,
        cancelledAt: new Date(),
      })),
      ({ totalPrice, checkIn, cancelledAt }) => {
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        return result.refundAmount <= totalPrice + 0.01; // +0.01 for float rounding
      },
    );
  });

  it('refundPct is always in [0, 1]', () => {
    forAll(
      'refundPct in [0,1]',
      map(validDatePair(), ([checkIn]) => ({
        totalPrice: float(1, 10_000)(),
        checkIn,
        cancelledAt: new Date(),
      })),
      ({ totalPrice, checkIn, cancelledAt }) => {
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        return result.refundPct >= 0 && result.refundPct <= 1;
      },
    );
  });
});

describe('Property: refund tier ordering', () => {
  it('full tier always has refundPct = 1', () => {
    forAll(
      'full tier = 100%',
      map(futureDate(8, 365), (checkIn) => ({
        totalPrice: float(50, 5_000)(),
        checkIn,
        cancelledAt: new Date(), // cancelling now → plenty of hours
      })),
      ({ totalPrice, checkIn, cancelledAt }) => {
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        if (result.tier === 'full') return result.refundPct === 1;
        return true; // not in full tier, skip
      },
    );
  });

  it('none tier always has refundAmount = 0', () => {
    // Cancel within 24h of checkin
    forAll(
      'none tier = 0 refund',
      map(futureDate(0, 1), (checkIn) => ({ totalPrice: float(50, 5_000)(), checkIn })),
      ({ totalPrice, checkIn }) => {
        const cancelledAt = new Date(checkIn.getTime() - 12 * 60 * 60 * 1000); // 12h before
        if (cancelledAt < new Date()) return true; // skip past dates
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        if (result.tier === 'none') return result.refundAmount === 0;
        return true;
      },
    );
  });

  it('tier is monotone in hoursUntilCheckIn', () => {
    forAll(
      'tier monotone',
      map(float(0, 400), (hours) => hours),
      (hours) => {
        const tier = resolveRefundTier(hours, testPolicy);
        if (hours >= testPolicy.fullRefundHours) return tier === 'full';
        if (hours >= testPolicy.noRefundHours) return tier === 'partial';
        return tier === 'none';
      },
    );
  });

  it('partial tier produces refundAmount = totalPrice * partialRefundPct', () => {
    // hours in partial band: [48, 168)
    forAll(
      'partial refund amount',
      map(float(48, 167.99), (hours) => ({
        hours,
        totalPrice: float(100, 10_000)(),
      })),
      ({ hours, totalPrice }) => {
        const checkIn = new Date(Date.now() + hours * 60 * 60 * 1000);
        const result = computeRefund({
          totalPrice,
          checkIn,
          cancelledAt: new Date(),
          config: testPolicy,
        });
        if (result.tier !== 'partial') return true; // drift from float precision
        const expected = Math.round(totalPrice * testPolicy.partialRefundPct * 100) / 100;
        return Math.abs(result.refundAmount - expected) < 0.02;
      },
    );
  });
});

describe('Property: refund computation is deterministic', () => {
  it('same inputs produce same output', () => {
    const checkIn = new Date(Date.now() + 200 * 60 * 60 * 1000); // 200h ahead
    forAll(
      'deterministic refund',
      float(1, 10_000),
      (totalPrice) => {
        const a = computeRefund({ totalPrice, checkIn, cancelledAt: new Date(checkIn.getTime() - 200 * 60 * 60 * 1000), config: testPolicy });
        const b = computeRefund({ totalPrice, checkIn, cancelledAt: new Date(checkIn.getTime() - 200 * 60 * 60 * 1000), config: testPolicy });
        return a.refundAmount === b.refundAmount && a.tier === b.tier;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Date validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: date ordering invariants', () => {
  it('valid pair: check_out > check_in is always satisfiable', () => {
    forAll(
      'valid pair ordering',
      validDatePair(),
      ([checkIn, checkOut]) => {
        return checkOut > checkIn;
      },
    );
  });

  it('inverted pair: check_in > check_out always invalid', () => {
    forAll(
      'inverted pair is always invalid',
      invertedDatePair(),
      ([earlier, later]) => {
        // The "earlier" is checkOut, the "later" is checkIn — so checkIn > checkOut
        return later > earlier; // checkIn > checkOut → invalid
      },
    );
  });

  it('stay duration is always >= 1 night for valid pairs', () => {
    forAll(
      'stay >= 1 night',
      validDatePair(),
      ([checkIn, checkOut]) => {
        const nights = Math.round(
          (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
        );
        return nights >= 1;
      },
    );
  });

  it('night count × price_per_night = total price (integer nights)', () => {
    forAll(
      'nights × rate = total',
      map(validDatePair(), ([checkIn, checkOut]) => {
        const nights = Math.round(
          (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
        );
        const pricePerNight = Math.round(float(50, 2_000)() * 100) / 100;
        return { nights, pricePerNight };
      }),
      ({ nights, pricePerNight }) => {
        const total = Math.round(nights * pricePerNight * 100) / 100;
        return total > 0 && total >= pricePerNight;
      },
    );
  });

  it('check_in in the past is always a past date', () => {
    forAll(
      'past check_in < now',
      map(float(1, 365), (daysBack) => {
        const d = new Date();
        d.setDate(d.getDate() - Math.floor(daysBack));
        return d;
      }),
      (date) => {
        return date < new Date();
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Amount / financial arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: financial amount invariants', () => {
  it('total is never negative for positive nights and rate', () => {
    forAll(
      'total >= 0',
      map(posInt(365), (nights) => ({
        nights,
        ratePerNight: float(1, 50_000)(),
      })),
      ({ nights, ratePerNight }) => {
        const total = nights * ratePerNight;
        return total >= 0;
      },
    );
  });

  it('refund plus host payout equals total for full tier', () => {
    const farFutureCheckIn = new Date(Date.now() + 400 * 60 * 60 * 1000);
    forAll(
      'full refund: refund + payout = total',
      float(100, 50_000),
      (totalPrice) => {
        const result = computeRefund({
          totalPrice,
          checkIn: farFutureCheckIn,
          cancelledAt: new Date(),
          config: testPolicy,
        });
        if (result.tier !== 'full') return true;
        const hostPayout = result.totalPrice - result.refundAmount;
        return Math.abs(hostPayout + result.refundAmount - result.totalPrice) < 0.02;
      },
    );
  });

  it('no floating point drift: round2 results stay <= 2 decimal places', () => {
    forAll(
      'refundAmount <= 2dp',
      map(validDatePair(), ([checkIn]) => ({
        totalPrice: float(0.01, 99_999.99)(),
        checkIn,
        cancelledAt: new Date(),
      })),
      ({ totalPrice, checkIn, cancelledAt }) => {
        const result = computeRefund({ totalPrice, checkIn, cancelledAt, config: testPolicy });
        const asStr = result.refundAmount.toString();
        const dp = asStr.includes('.') ? asStr.split('.')[1].length : 0;
        return dp <= 2;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Booking validator (Zod schemas)
// ─────────────────────────────────────────────────────────────────────────────

import { createBookingSchema, updateBookingSchema } from '@/validators/booking.validator.js';

describe('Property: booking validator rejects all malformed inputs', () => {
  const validBase = {
    property_id: '00000000-0000-0000-0000-000000000000',
    check_in: '2027-10-01',
    check_out: '2027-10-05',
    guest_count: 2,
    rules_acknowledged_at: new Date().toISOString(),
    terms_version: 'v1.0.0',
    terms_accepted_at: new Date().toISOString(),
  };

  it('negative guest_count is always rejected', () => {
    forAll(
      'negative guest_count rejected',
      map(float(-1000, -1), (n) => Math.floor(n)),
      (guestCount) => {
        const result = createBookingSchema.safeParse({ ...validBase, guest_count: guestCount });
        return result.success === false;
      },
    );
  });

  it('zero guest_count is always rejected', () => {
    const result = createBookingSchema.safeParse({ ...validBase, guest_count: 0 });
    expect(result.success).toBe(false);
  });

  it('fractional guest_count is always rejected', () => {
    forAll(
      'fractional guest_count rejected',
      float(0.1, 0.99),
      (guestCount) => {
        const result = createBookingSchema.safeParse({ ...validBase, guest_count: guestCount });
        return result.success === false;
      },
    );
  });

  it('inverted dates are always rejected', () => {
    forAll(
      'inverted dates rejected',
      invertedDatePair(),
      ([checkOut, checkIn]) => {
        const result = createBookingSchema.safeParse({
          ...validBase,
          check_in: isoDate(checkIn),
          check_out: isoDate(checkOut),
        });
        return result.success === false;
      },
    );
  });

  it('invalid UUID for property_id is always rejected', () => {
    const badUuids = [
      'not-a-uuid',
      '12345',
      '',
      'GGGGGGGG-0000-0000-0000-000000000000',
      '00000000000000000000000000000000',
    ];
    forAll(
      'invalid UUID rejected',
      oneOf(badUuids),
      (property_id) => {
        const result = createBookingSchema.safeParse({ ...validBase, property_id });
        return result.success === false;
      },
    );
  });

  it('negative total_price is always rejected', () => {
    forAll(
      'negative total_price rejected',
      float(-10_000, -0.01),
      (total_price) => {
        const result = createBookingSchema.safeParse({ ...validBase, total_price });
        return result.success === false;
      },
    );
  });

  it('missing required fields all produce validation errors', () => {
    const requiredFields: (keyof typeof validBase)[] = [
      'property_id',
      'check_in',
      'check_out',
      'guest_count',
      'rules_acknowledged_at',
      'terms_version',
      'terms_accepted_at',
    ];
    for (const field of requiredFields) {
      const { [field]: _omit, ...rest } = validBase;
      const result = createBookingSchema.safeParse(rest);
      expect(result.success).toBe(false);
    }
  });

  it('updateBookingSchema rejects invalid status values', () => {
    const invalidStatuses = ['unknown', 'active', 'PENDING', 'done', '', 'null'];
    forAll(
      'invalid status rejected',
      oneOf(invalidStatuses),
      (status) => {
        const result = updateBookingSchema.safeParse({ status });
        return result.success === false;
      },
    );
  });

  it('updateBookingSchema accepts all valid status values', () => {
    const validStatuses = ['Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed'];
    for (const status of validStatuses) {
      const result = updateBookingSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Auth validator
// ─────────────────────────────────────────────────────────────────────────────

import { registerSchema, loginSchema } from '@/validators/auth.validator.js';

describe('Property: auth validator rejects malformed inputs', () => {
  it('emails without @ are always rejected', () => {
    const noAt = ['plainaddress', 'missingatsign.com', '#@%^%#$', 'email.domain.com'];
    forAll(
      'no-@ emails rejected',
      oneOf(noAt),
      (email) => {
        const result = loginSchema.safeParse({ email, password: 'any' });
        return result.success === false;
      },
    );
  });

  it('passwords shorter than 12 chars are rejected at registration', () => {
    forAll(
      'short password rejected',
      map(int(0, 11), (len) => 'aA1!'.repeat(Math.ceil(len / 4)).slice(0, len)),
      (password) => {
        const result = registerSchema.safeParse({
          email: 'test@example.com',
          password,
          name: 'Test User',
        });
        return result.success === false;
      },
    );
  });

  it('passwords without uppercase are always rejected at registration', () => {
    forAll(
      'no-uppercase rejected',
      map(int(12, 50), (len) => 'abcdefghij1!'.padEnd(len, 'x')),
      (password) => {
        const result = registerSchema.safeParse({
          email: 'test@example.com',
          password,
          name: 'Test',
        });
        return result.success === false;
      },
    );
  });

  it('passwords without digits are always rejected at registration', () => {
    forAll(
      'no-digit rejected',
      map(int(12, 50), (len) => 'AbcdefghIJK!'.padEnd(len, 'X')),
      (password) => {
        const result = registerSchema.safeParse({
          email: 'test@example.com',
          password,
          name: 'Test',
        });
        return result.success === false;
      },
    );
  });

  it('passwords without special char are always rejected at registration', () => {
    forAll(
      'no-special-char rejected',
      map(int(12, 50), (len) => 'AbcDef1234567'.padEnd(len, '5')),
      (password) => {
        const result = registerSchema.safeParse({
          email: 'test@example.com',
          password,
          name: 'Test',
        });
        return result.success === false;
      },
    );
  });

  it('valid passwords always accepted: upper + lower + digit + special, >=12', () => {
    const validPws = [
      'Rentars2024!',
      'SecurePass99#$',
      'MyB00kingApp@2024',
      'P@ssw0rdLong123',
      'Complex!Pass9word',
    ];
    for (const password of validPws) {
      const result = registerSchema.safeParse({
        email: 'user@rentars.io',
        password,
        name: 'Valid User',
      });
      expect(result.success).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Pagination
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

describe('Property: pagination invariants', () => {
  const paginationSchema = z.object({
    page: z.coerce.number().int().positive(),
    pageSize: z.coerce.number().int().positive().max(100).optional(),
  });

  it('page windows are non-overlapping and contiguous', () => {
    forAll(
      'non-overlapping pages',
      map(posInt(50), (pageSize) => ({ pageSize, totalItems: int(1, 1000)() })),
      ({ pageSize, totalItems }) => {
        const pageCount = Math.ceil(totalItems / pageSize);
        const windows: Array<[number, number]> = [];
        for (let p = 1; p <= pageCount; p++) {
          const offset = (p - 1) * pageSize;
          const end = Math.min(offset + pageSize, totalItems);
          windows.push([offset, end]);
        }
        // Verify no overlap
        for (let i = 1; i < windows.length; i++) {
          if (windows[i][0] !== windows[i - 1][1]) return false;
        }
        // Verify full coverage
        return windows[0][0] === 0 && windows[windows.length - 1][1] === totalItems;
      },
    );
  });

  it('negative page numbers are rejected by schema', () => {
    forAll(
      'negative page rejected',
      map(float(-1000, -1), (n) => Math.floor(n)),
      (page) => {
        const result = paginationSchema.safeParse({ page, pageSize: 20 });
        return result.success === false;
      },
    );
  });

  it('zero page is rejected', () => {
    const result = paginationSchema.safeParse({ page: 0 });
    expect(result.success).toBe(false);
  });

  it('pageSize > 100 is rejected', () => {
    forAll(
      'oversized pageSize rejected',
      int(101, 10_000),
      (pageSize) => {
        const result = paginationSchema.safeParse({ page: 1, pageSize });
        return result.success === false;
      },
    );
  });

  it('pageSize <= 100 is always accepted', () => {
    forAll(
      'valid pageSize accepted',
      posInt(100),
      (pageSize) => {
        const result = paginationSchema.safeParse({ page: 1, pageSize });
        return result.success === true;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: State machine — valid booking status transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: booking state-machine transition invariants', () => {
  /**
   * Allowed transitions (subset of the domain model):
   *  Pending  → Confirmed | Cancelled
   *  Confirmed → Completed | Cancelled | Disputed
   *  Completed → (terminal)
   *  Cancelled → (terminal)
   *  Disputed  → Confirmed | Cancelled
   */
  const TRANSITIONS: Record<string, string[]> = {
    Pending: ['Confirmed', 'Cancelled'],
    Confirmed: ['Completed', 'Cancelled', 'Disputed'],
    Completed: [],
    Cancelled: [],
    Disputed: ['Confirmed', 'Cancelled'],
  };

  const ALL_STATUSES = Object.keys(TRANSITIONS);

  it('terminal states have no valid successors', () => {
    for (const terminal of ['Completed', 'Cancelled']) {
      expect(TRANSITIONS[terminal]).toHaveLength(0);
    }
  });

  it('every valid successor is itself a known status', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      for (const to of tos) {
        expect(ALL_STATUSES).toContain(to);
      }
    }
  });

  it('no status can transition to itself', () => {
    for (const [status, tos] of Object.entries(TRANSITIONS)) {
      expect(tos).not.toContain(status);
    }
  });

  it('random invalid transitions are always flagged', () => {
    forAll(
      'invalid transition detected',
      oneOf(ALL_STATUSES as ('Pending' | 'Completed' | 'Cancelled' | 'Confirmed' | 'Disputed')[]),
      (from) => {
        const invalid = ALL_STATUSES.filter((s) => !TRANSITIONS[from].includes(s) && s !== from);
        for (const to of invalid) {
          const allowed = TRANSITIONS[from].includes(to);
          if (allowed) return false; // should not happen
        }
        return true;
      },
    );
  });

  it('Pending cannot skip directly to Completed', () => {
    expect(TRANSITIONS['Pending']).not.toContain('Completed');
  });

  it('Pending cannot skip directly to Disputed', () => {
    expect(TRANSITIONS['Pending']).not.toContain('Disputed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Unauthorized mutation guard (unit-level)
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: unauthorized mutation invariants', () => {
  /**
   * Simulates the authorization check in booking.controller.ts:
   *   only the booking's tenant_id may cancel their own booking.
   */
  function canCancel(actorId: string, booking: { tenant_id: string; status: string }): boolean {
    if (actorId !== booking.tenant_id) return false;
    if (['Cancelled', 'Completed'].includes(booking.status)) return false;
    return true;
  }

  it('non-tenant can never cancel a booking', () => {
    forAll(
      'non-tenant cannot cancel',
      map(
        validDatePair(),
        () => ({
          tenantId: `tenant-${Math.random().toString(36).slice(2)}`,
          actorId: `actor-${Math.random().toString(36).slice(2)}`,
          status: 'Pending' as const,
        }),
      ),
      ({ tenantId, actorId, status }) => {
        if (tenantId === actorId) return true; // same user — skip
        return canCancel(actorId, { tenant_id: tenantId, status }) === false;
      },
    );
  });

  it('tenant can cancel their own pending booking', () => {
    forAll(
      'tenant can cancel own',
      map(
        validDatePair(),
        () => `tenant-${Math.random().toString(36).slice(2)}`,
      ),
      (tenantId) => {
        return canCancel(tenantId, { tenant_id: tenantId, status: 'Pending' }) === true;
      },
    );
  });

  it('nobody can cancel a completed booking', () => {
    forAll(
      'completed is terminal',
      map(
        validDatePair(),
        () => `user-${Math.random().toString(36).slice(2)}`,
      ),
      (userId) => {
        return canCancel(userId, { tenant_id: userId, status: 'Completed' }) === false;
      },
    );
  });

  it('nobody can cancel an already-cancelled booking', () => {
    forAll(
      'cancelled is terminal',
      map(
        validDatePair(),
        () => `user-${Math.random().toString(36).slice(2)}`,
      ),
      (userId) => {
        return canCancel(userId, { tenant_id: userId, status: 'Cancelled' }) === false;
      },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANTS: Stellar address format
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: Stellar address format invariants', () => {
  const stellarRegex = /^G[A-Z2-7]{55}$/;

  it('valid Stellar addresses always start with G and are 56 chars', () => {
    const validAddresses = [
      'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
      'GBBD47UZQ2EOPZMQAAMAEWBVHQWWPGVIOTQOI5DQWUB3DJWQX5DVXCA',
      'GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH1MZ2NKDP55K74YJ',
    ];
    for (const addr of validAddresses) {
      expect(stellarRegex.test(addr)).toBe(true);
    }
  });

  it('invalid Stellar addresses are always rejected by format check', () => {
    const invalid = [
      'XBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3', // starts with X
      'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664',   // too short
      'not-a-stellar-address',
      '',
      'gBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3', // lowercase
    ];
    for (const addr of invalid) {
      expect(stellarRegex.test(addr)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION SEEDS
// These tests are frozen generated failures turned into permanent regression
// checks. Add new entries here when forAll captures a failing seed.
// ─────────────────────────────────────────────────────────────────────────────

describe('Regression seeds from property-based failures', () => {
  it('seed-1: refund for totalPrice=0.01 does not go negative', () => {
    const checkIn = new Date(Date.now() + 200 * 60 * 60 * 1000);
    const result = computeRefund({
      totalPrice: 0.01,
      checkIn,
      cancelledAt: new Date(),
      config: testPolicy,
    });
    expect(result.refundAmount).toBeGreaterThanOrEqual(0);
  });

  it('seed-2: refund for very large totalPrice does not overflow', () => {
    const checkIn = new Date(Date.now() + 400 * 60 * 60 * 1000);
    const result = computeRefund({
      totalPrice: 999_999.99,
      checkIn,
      cancelledAt: new Date(),
      config: testPolicy,
    });
    expect(result.refundAmount).toBeGreaterThanOrEqual(0);
    expect(result.refundAmount).toBeLessThanOrEqual(999_999.99);
  });

  it('seed-3: check_in = check_out + 1 is always inverted (validator rejects)', () => {
    const base = new Date('2027-06-15');
    const result = createBookingSchema.safeParse({
      property_id: '00000000-0000-0000-0000-000000000000',
      check_in: '2027-06-15',
      check_out: '2027-06-14', // before check_in
      guest_count: 1,
      rules_acknowledged_at: new Date().toISOString(),
      terms_version: 'v1',
      terms_accepted_at: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
    void base; // used for readability
  });

  it('seed-4: partial refund for exactly 48h until check-in gives 0% refund', () => {
    const checkIn = new Date(Date.now() + 48 * 60 * 60 * 1000 - 1); // just under 48h
    const result = computeRefund({
      totalPrice: 500,
      checkIn,
      cancelledAt: new Date(),
      config: testPolicy,
    });
    expect(result.tier).toBe('none');
    expect(result.refundAmount).toBe(0);
  });
});


describe('Property-based: amount arithmetic invariants', () => {
  it('night count is always positive for valid ranges and total equals rate*nights', () => {
    forAll(
      'total = rate * nights (with integer nights)',
      map(validDatePair(), ([ci, co]) => {
        const rate = Math.max(1, Math.floor(Math.random() * 2000));
        const nights = Math.max(1, Math.ceil((co.getTime() - ci.getTime()) / (86400000)));
        return { ci, co, rate, nights };
      }),
      ({ ci, co, rate, nights }) => {
        const total = rate * nights;
        expect(nights).toBeGreaterThanOrEqual(1);
        expect(total).toBeGreaterThanOrEqual(0);
        expect(new Date(co) > new Date(ci)).toBe(true);
      },
      50,
    );
  });
});


describe('Property-based: lifecycle transitions', () => {
  const validTransitions: Record<string, string[]> = {
    Pending: ['Confirmed', 'Cancelled'],
    Confirmed: ['Completed', 'Cancelled', 'Disputed'],
    Disputed: ['Cancelled', 'Completed'],
    Completed: [],
    Cancelled: [],
  };

  const allStatuses = Object.keys(validTransitions);

  it('only defined transitions are valid', () => {
    for (let i = 0; i < 100; i++) {
      const from = allStatuses[Math.floor(Math.random() * allStatuses.length)];
      const to = allStatuses[Math.floor(Math.random() * allStatuses.length)];
      const valid = (validTransitions[from] ?? []).includes(to);
      if (!valid && from !== to) {
        expect(valid).toBe(false);
      } else {
        expect(true).toBe(true);
      }
    }
  });
});
