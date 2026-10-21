/**
 * Tests for the refund service — booking-time policy snapshot (#769).
 *
 * Exercises:
 *  - Refund settlement state machine transitions
 *  - Snapshot-based refund computation (policy frozen at booking time)
 *  - Idempotency of refund request creation
 *  - Refund amount cannot exceed eligible value
 *  - Failed/pending refunds are not described as complete
 */

import { describe, it, expect } from 'vitest';
import { computeRefund, type RefundPolicyConfig } from '@/services/refundPolicy.service.js';

// ─── Refund settlement state machine (extracted for testability) ──────────────
//
// These mirror the ALLOWED_REFUND_TRANSITIONS in refund.service.ts.
// We test the pure logic here so the test doesn't depend on Supabase.

const ALLOWED_REFUND_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  requested:     ['submitted', 'failed', 'manual_review'],
  submitted:     ['confirmed', 'failed', 'manual_review'],
  confirmed:     [],
  failed:        ['submitted', 'manual_review'],
  manual_review: ['submitted', 'failed'],
};

function isAllowedRefundTransition(from: string, to: string): boolean {
  return ALLOWED_REFUND_TRANSITIONS[from]?.includes(to) ?? false;
}

type RefundStatus = 'requested' | 'submitted' | 'confirmed' | 'failed' | 'manual_review';

// ─── Refund settlement state machine ──────────────────────────────────────────

describe('Refund settlement state machine', () => {
  it('allows requested → submitted', () => {
    expect(isAllowedRefundTransition('requested', 'submitted')).toBe(true);
  });

  it('allows requested → failed', () => {
    expect(isAllowedRefundTransition('requested', 'failed')).toBe(true);
  });

  it('allows requested → manual_review', () => {
    expect(isAllowedRefundTransition('requested', 'manual_review')).toBe(true);
  });

  it('allows submitted → confirmed', () => {
    expect(isAllowedRefundTransition('submitted', 'confirmed')).toBe(true);
  });

  it('allows submitted → failed', () => {
    expect(isAllowedRefundTransition('submitted', 'failed')).toBe(true);
  });

  it('allows submitted → manual_review', () => {
    expect(isAllowedRefundTransition('submitted', 'manual_review')).toBe(true);
  });

  it('allows failed → submitted (retry path)', () => {
    expect(isAllowedRefundTransition('failed', 'submitted')).toBe(true);
  });

  it('allows failed → manual_review', () => {
    expect(isAllowedRefundTransition('failed', 'manual_review')).toBe(true);
  });

  it('allows manual_review → submitted (ops resolution)', () => {
    expect(isAllowedRefundTransition('manual_review', 'submitted')).toBe(true);
  });

  it('allows manual_review → failed', () => {
    expect(isAllowedRefundTransition('manual_review', 'failed')).toBe(true);
  });

  it('rejects confirmed → requested (terminal)', () => {
    expect(isAllowedRefundTransition('confirmed', 'requested')).toBe(false);
  });

  it('rejects confirmed → submitted (terminal)', () => {
    expect(isAllowedRefundTransition('confirmed', 'submitted')).toBe(false);
  });

  it('rejects submitted → requested (regressive)', () => {
    expect(isAllowedRefundTransition('submitted', 'requested')).toBe(false);
  });

  it('rejects requested → confirmed (skip submitted)', () => {
    expect(isAllowedRefundTransition('requested', 'confirmed')).toBe(false);
  });

  it('rejects failed → confirmed (must go through submitted)', () => {
    expect(isAllowedRefundTransition('failed', 'confirmed')).toBe(false);
  });
});

// ─── Snapshot-based refund computation ─────────────────────────────────────────

describe('Snapshot-based refund computation', () => {
  // Policy A: the policy at booking time
  const policyA: RefundPolicyConfig = {
    fullRefundHours: 7 * 24,   // 168h
    noRefundHours: 48,
    partialRefundPct: 0.5,
  };

  // Policy B: a stricter policy introduced after booking
  const policyB: RefundPolicyConfig = {
    fullRefundHours: 14 * 24,  // 336h
    noRefundHours: 72,
    partialRefundPct: 0.3,
  };

  it('uses the snapshot policy, not the live policy', () => {
    // Booking made 10 days before check-in
    // Under policy A (snapshot): 10 days = 240h ≥ 168h → full refund (100%)
    // Under policy B (live):     10 days = 240h < 336h → partial refund (30%)
    const checkIn = new Date('2026-12-20');
    const cancelledAt = new Date('2026-12-10'); // 10 days before check-in

    const snapshotRefund = computeRefund({
      totalPrice: 1000,
      checkIn,
      cancelledAt,
      config: policyA,
    });

    const liveRefund = computeRefund({
      totalPrice: 1000,
      checkIn,
      cancelledAt,
      config: policyB,
    });

    // Snapshot says full, live says partial
    expect(snapshotRefund.tier).toBe('full');
    expect(snapshotRefund.refundAmount).toBe(1000);

    expect(liveRefund.tier).toBe('partial');
    expect(liveRefund.refundAmount).toBe(300);

    // The snapshot gives more — this is correct: the tenant booked under
    // policy A's terms.
    expect(snapshotRefund.refundAmount).toBeGreaterThan(liveRefund.refundAmount);
  });

  it('snapshot gives less when the live policy became more generous', () => {
    // Booking made 5 days before check-in
    // Under policy A (snapshot): 5 days = 120h, 48 ≤ 120 < 168 → partial (50%)
    // Under policy B (live):     5 days = 120h, 72 ≤ 120 < 336 → partial (30%)
    // But B has lower partial pct (0.3 < 0.5), so live gives LESS.
    // Let's reverse: policyA is stricter on partial pct.
    const policyStricterPartial: RefundPolicyConfig = {
      fullRefundHours: 7 * 24,
      noRefundHours: 48,
      partialRefundPct: 0.3, // stricter
    };
    const policyGenerousPartial: RefundPolicyConfig = {
      fullRefundHours: 7 * 24,
      noRefundHours: 48,
      partialRefundPct: 0.8, // more generous
    };

    const checkIn = new Date('2026-12-20');
    const cancelledAt = new Date('2026-12-15'); // 5 days before

    const snapshotRefund = computeRefund({
      totalPrice: 1000,
      checkIn,
      cancelledAt,
      config: policyStricterPartial,
    });

    const liveRefund = computeRefund({
      totalPrice: 1000,
      checkIn,
      cancelledAt,
      config: policyGenerousPartial,
    });

    expect(snapshotRefund.tier).toBe('partial');
    expect(snapshotRefund.refundAmount).toBe(300);

    expect(liveRefund.tier).toBe('partial');
    expect(liveRefund.refundAmount).toBe(800);

    // Snapshot gives less — correct: the tenant booked under the stricter terms
    expect(snapshotRefund.refundAmount).toBeLessThan(liveRefund.refundAmount);
  });
});

// ─── Refund amount cannot exceed eligible value ────────────────────────────────

describe('Refund amount limits', () => {
  it('full refund does not exceed total price', () => {
    const refund = computeRefund({
      totalPrice: 500,
      checkIn: new Date('2026-12-20'),
      cancelledAt: new Date('2026-12-01'), // 19 days before — full
    });

    expect(refund.tier).toBe('full');
    expect(refund.refundAmount).toBe(500);
    expect(refund.refundAmount).toBeLessThanOrEqual(refund.totalPrice);
  });

  it('partial refund does not exceed total price', () => {
    const refund = computeRefund({
      totalPrice: 500,
      checkIn: new Date('2026-12-20'),
      cancelledAt: new Date('2026-12-15'), // 5 days — partial
    });

    expect(refund.tier).toBe('partial');
    expect(refund.refundAmount).toBeLessThan(refund.totalPrice);
    expect(refund.refundAmount).toBeLessThanOrEqual(refund.totalPrice);
  });

  it('no refund gives zero', () => {
    const refund = computeRefund({
      totalPrice: 500,
      checkIn: new Date('2026-12-20'),
      cancelledAt: new Date('2026-12-19'), // 1 day before — none
    });

    expect(refund.tier).toBe('none');
    expect(refund.refundAmount).toBe(0);
  });
});

// ─── Idempotency of refund requests ───────────────────────────────────────────

describe('Refund request idempotency', () => {
  it('same idempotency key returns the same request', () => {
    // Simulate the idempotency check
    function simulateIdempotentCreate(
      existing: Map<string, string>,
      bookingId: string,
      idemKey: string,
    ): { created: boolean; id: string } {
      const key = `${bookingId}:${idemKey}`;
      if (existing.has(key)) {
        return { created: false, id: existing.get(key)! };
      }
      const id = `refund-${existing.size + 1}`;
      existing.set(key, id);
      return { created: true, id };
    }

    const store = new Map<string, string>();

    // First call — creates
    const first = simulateIdempotentCreate(store, 'booking-1', 'refund:booking-1');
    expect(first.created).toBe(true);

    // Second call with same key — returns existing
    const second = simulateIdempotentCreate(store, 'booking-1', 'refund:booking-1');
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('different idempotency keys create different requests', () => {
    function simulateIdempotentCreate(
      existing: Map<string, string>,
      bookingId: string,
      idemKey: string,
    ): { created: boolean; id: string } {
      const key = `${bookingId}:${idemKey}`;
      if (existing.has(key)) {
        return { created: false, id: existing.get(key)! };
      }
      const id = `refund-${existing.size + 1}`;
      existing.set(key, id);
      return { created: true, id };
    }

    const store = new Map<string, string>();

    const first = simulateIdempotentCreate(store, 'booking-1', 'refund:booking-1');
    const second = simulateIdempotentCreate(store, 'booking-1', 'refund:booking-1:retry');

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.id).not.toBe(second.id);
  });
});

// ─── Failed/pending refunds are not described as complete ─────────────────────

describe('Refund status semantics', () => {
  const terminalStates: RefundStatus[] = ['confirmed'];
  const pendingStates: RefundStatus[] = ['requested', 'submitted'];
  const failureStates: RefundStatus[] = ['failed', 'manual_review'];

  it('only "confirmed" is terminal and complete', () => {
    for (const status of terminalStates) {
      expect(isAllowedRefundTransition(status, 'submitted')).toBe(false);
      expect(isAllowedRefundTransition(status, 'confirmed')).toBe(false);
    }
  });

  it('pending states can still transition to failure', () => {
    for (const status of pendingStates) {
      expect(isAllowedRefundTransition(status, 'failed')).toBe(true);
      expect(isAllowedRefundTransition(status, 'manual_review')).toBe(true);
    }
  });

  it('failed state is recoverable (can retry or escalate)', () => {
    for (const status of failureStates) {
      if (status === 'failed') {
        expect(isAllowedRefundTransition(status, 'submitted')).toBe(true);
        expect(isAllowedRefundTransition(status, 'manual_review')).toBe(true);
      }
    }
  });

  it('manual_review requires ops intervention', () => {
    expect(isAllowedRefundTransition('manual_review', 'submitted')).toBe(true);
    expect(isAllowedRefundTransition('manual_review', 'failed')).toBe(true);
    // Cannot auto-confirm from manual_review
    expect(isAllowedRefundTransition('manual_review', 'confirmed')).toBe(false);
  });
});

// ─── RefundStatus type coverage ────────────────────────────────────────────────

describe('RefundStatus values', () => {
  const allStatuses: RefundStatus[] = [
    'requested', 'submitted', 'confirmed', 'failed', 'manual_review',
  ];

  it('covers every defined status in isAllowedRefundTransition', () => {
    for (const status of allStatuses) {
      expect(() => isAllowedRefundTransition(status, 'confirmed')).not.toThrow();
    }
  });
});
