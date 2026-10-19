/**
 * Fee, Settlement & Cancellation Disclosure (Issue #115)
 *
 * Builds the final pre-confirmation disclosure (total, currency, fee
 * breakdown, refund rules, material risks) from the centralized policy
 * source of truth, and records immutable per-booking terms acceptance so
 * later policy edits never change existing bookings' terms.
 *
 * Complements `platformPolicy.service.ts` (policy data + snapshots).
 */

import {
  BLOCKCHAIN_RISKS,
  ESCROW_POLICY,
  PLATFORM_FEE_PCT,
  REFUND_TIERS,
  getCurrentPolicySnapshot,
} from './platformPolicy.service.js';

export interface FeeLineItem {
  label: string;
  amountUsdc: number;
}

export interface QuoteDisclosure {
  subtotalUsdc: number;
  platformFeeUsdc: number;
  totalUsdc: number;
  currency: 'USDC';
  lines: FeeLineItem[];
  escrowSummary: string;
  refundRules: string[];
  materialRisks: string[];
  termsVersion: string;
}

export interface TermsAcceptance {
  bookingId: string;
  actorId: string;
  actorRole: 'tenant' | 'host';
  termsVersion: string;
  acceptedAt: string; // ISO-8601 UTC
  totalUsdc: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Line-item totals for a quote: nightly rate × nights + platform fee. */
export function buildQuoteDisclosure(
  nightlyUsdc: number,
  nights: number,
): QuoteDisclosure {
  const subtotalUsdc = round2(nightlyUsdc * nights);
  const platformFeeUsdc = round2(subtotalUsdc * PLATFORM_FEE_PCT);
  const totalUsdc = round2(subtotalUsdc + platformFeeUsdc);
  const snapshot = getCurrentPolicySnapshot();
  return {
    subtotalUsdc,
    platformFeeUsdc,
    totalUsdc,
    currency: 'USDC',
    lines: [
      { label: `Accommodation (${nights} night(s) × ${nightlyUsdc} USDC)`, amountUsdc: subtotalUsdc },
      { label: `Platform fee (${PLATFORM_FEE_PCT * 100} %)`, amountUsdc: platformFeeUsdc },
    ],
    escrowSummary: `${ESCROW_POLICY.holdDescription} Settlement in ${ESCROW_POLICY.currency} on ${ESCROW_POLICY.network} via ${ESCROW_POLICY.provider}.`,
    refundRules: REFUND_TIERS.map((t) => t.description),
    materialRisks: [...BLOCKCHAIN_RISKS],
    termsVersion: snapshot.version,
  };
}

/** Records actor + timestamp acceptance of the disclosed terms version. */
export function recordTermsAcceptance(
  bookingId: string,
  actorId: string,
  actorRole: 'tenant' | 'host',
  disclosure: QuoteDisclosure,
  acceptedAt: string = new Date().toISOString(),
): TermsAcceptance {
  return {
    bookingId,
    actorId,
    actorRole,
    termsVersion: disclosure.termsVersion,
    acceptedAt,
    totalUsdc: disclosure.totalUsdc,
  };
}

/**
 * Immutability guard: returns true when the stored acceptance still pins
 * the booking to its original policy version. Callers must never overwrite
 * `acceptance.termsVersion` when the platform publishes a newer version —
 * historical bookings retain their original terms.
 */
export function bookingRetainsOriginalTerms(
  acceptance: TermsAcceptance,
  storedVersion: string,
): boolean {
  return acceptance.termsVersion === storedVersion;
}
