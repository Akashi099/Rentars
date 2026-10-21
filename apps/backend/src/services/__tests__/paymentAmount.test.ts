/**
 * Tests for payment amount and currency integrity utilities (#612).
 *
 * Exercises:
 *  - usdcToStroops() conversion and precision validation
 *  - stroopsToUsdc() human-readable display
 *  - validatePaymentAmount() schema enforcement
 *  - reconcileAmounts() match / mismatch detection
 *  - signQuote() / verifyQuote() tamper-detection
 *  - buildAmountBreakdown() output shape
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { validateSignedPaymentTransaction } from '@/services/stellar.service.js';

afterEach(() => vi.unstubAllEnvs());
import {
  usdcToStroops,
  stroopsToUsdc,
  validatePaymentAmount,
  reconcileAmounts,
  signQuote,
  verifyQuote,
  buildAmountBreakdown,
  STROOPS_PER_USDC,
  MIN_USDC_AMOUNT,
  MAX_USDC_AMOUNT,
} from '@/utils/payment.utils.js';

// ─── usdcToStroops ────────────────────────────────────────────────────────────

describe('usdcToStroops', () => {
  it('converts integer USDC correctly', () => {
    expect(usdcToStroops('1')).toBe(STROOPS_PER_USDC);
  });

  it('converts 1.5 USDC to 15_000_000 stroops', () => {
    expect(usdcToStroops('1.5')).toBe(15_000_000n);
  });

  it('converts 0.0000001 USDC (minimum precision)', () => {
    expect(usdcToStroops('0.0000001')).toBe(1n);
  });

  it('converts 1000 USDC to 10_000_000_000_000 stroops', () => {
    expect(usdcToStroops('1000')).toBe(1_000n * STROOPS_PER_USDC);
  });

  it('rejects more than 7 decimal places', () => {
    expect(() => usdcToStroops('1.00000001')).toThrow(RangeError);
  });

  it('rejects negative amounts', () => {
    expect(() => usdcToStroops('-1')).toThrow(RangeError);
  });

  it('rejects e-notation', () => {
    expect(() => usdcToStroops('1e5')).toThrow(RangeError);
  });

  it('rejects empty string', () => {
    expect(() => usdcToStroops('')).toThrow(RangeError);
  });

  it('rejects NaN string', () => {
    expect(() => usdcToStroops('NaN')).toThrow(RangeError);
  });
});

// ─── stroopsToUsdc ────────────────────────────────────────────────────────────

describe('stroopsToUsdc', () => {
  it('converts 10_000_000 stroops to "1.00"', () => {
    expect(stroopsToUsdc(STROOPS_PER_USDC)).toBe('1.00');
  });

  it('converts 15_000_000 stroops to "1.50"', () => {
    expect(stroopsToUsdc(15_000_000n)).toBe('1.50');
  });

  it('converts 0 stroops to "0.00"', () => {
    expect(stroopsToUsdc(0n)).toBe('0.00');
  });

  it('converts large amount without overflow', () => {
    const result = stroopsToUsdc(1_000_000n * STROOPS_PER_USDC);
    expect(result).toBe('1000000.00');
  });

  it('preserves sub-cent precision in display strings', () => {
    expect(stroopsToUsdc(1n)).toBe('0.0000001');
    expect(stroopsToUsdc(1_000n)).toBe('0.0001');
    expect(stroopsToUsdc(9_999_999n)).toBe('0.9999999');
  });
});

// ─── validatePaymentAmount ────────────────────────────────────────────────────

describe('validatePaymentAmount', () => {
  it('returns no errors for valid stroops string and USDC', () => {
    const errors = validatePaymentAmount('10000000', 'USDC');
    expect(errors).toHaveLength(0);
  });

  it('rejects a floating-point number (not string)', () => {
    const errors = validatePaymentAmount(10.5, 'USDC');
    expect(errors.some((e) => e.field === 'amountStroops')).toBe(true);
  });

  it('rejects a decimal string', () => {
    const errors = validatePaymentAmount('10.5', 'USDC');
    expect(errors.some((e) => e.field === 'amountStroops')).toBe(true);
  });

  it('rejects negative integer string', () => {
    const errors = validatePaymentAmount('-100', 'USDC');
    expect(errors.some((e) => e.field === 'amountStroops')).toBe(true);
  });

  it('rejects unsupported currency', () => {
    const errors = validatePaymentAmount('10000000', 'BTC');
    expect(errors.some((e) => e.field === 'currency')).toBe(true);
  });

  it('rejects empty currency', () => {
    const errors = validatePaymentAmount('10000000', '');
    expect(errors.some((e) => e.field === 'currency')).toBe(true);
  });

  it('reports both amount and currency errors together', () => {
    const errors = validatePaymentAmount('10.5', 'BTC');
    expect(errors.some((e) => e.field === 'amountStroops')).toBe(true);
    expect(errors.some((e) => e.field === 'currency')).toBe(true);
  });

  it('rejects amount below minimum', () => {
    const errors = validatePaymentAmount('1', 'USDC'); // 1 stroop < MIN_USDC_AMOUNT
    expect(errors.some((e) => e.field === 'amountStroops')).toBe(true);
  });
});

// ─── reconcileAmounts ────────────────────────────────────────────────────────

describe('reconcileAmounts', () => {
  it('returns match=true when amounts are equal', () => {
    const result = reconcileAmounts(10_000_000n, 10_000_000n);
    expect(result.match).toBe(true);
  });

  it('returns match=false with diff when on-chain is higher', () => {
    const result = reconcileAmounts(10_000_000n, 12_000_000n);
    expect(result.match).toBe(false);
    if (!result.match) {
      expect(result.diff).toBe(2_000_000n);
    }
  });

  it('returns match=false with negative diff when on-chain is lower', () => {
    const result = reconcileAmounts(10_000_000n, 8_000_000n);
    expect(result.match).toBe(false);
    if (!result.match) {
      expect(result.diff).toBe(-2_000_000n);
      expect(result.expected).toBe(10_000_000n);
      expect(result.actual).toBe(8_000_000n);
    }
  });

  it('handles zero amounts', () => {
    const result = reconcileAmounts(0n, 0n);
    expect(result.match).toBe(true);
  });
});

// ─── signQuote / verifyQuote ──────────────────────────────────────────────────

describe('signQuote / verifyQuote', () => {
  const secret = 'test-quote-secret-must-be-set-in-env';
  const bookingId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const amountStroops = 10_000_000n;
  const currency = 'USDC' as const;
  const expiresAt = new Date(Date.now() + 60_000).toISOString(); // 1 min from now

  it('verifies a freshly signed quote', () => {
    const hash = signQuote(bookingId, amountStroops, currency, expiresAt, secret);
    expect(verifyQuote(hash, bookingId, amountStroops, currency, expiresAt, secret)).toBe(true);
  });

  it('rejects a tampered amount', () => {
    const hash = signQuote(bookingId, amountStroops, currency, expiresAt, secret);
    expect(verifyQuote(hash, bookingId, 9_000_000n, currency, expiresAt, secret)).toBe(false);
  });

  it('rejects a tampered bookingId', () => {
    const hash = signQuote(bookingId, amountStroops, currency, expiresAt, secret);
    const otherId = '00000000-0000-0000-0000-000000000002';
    expect(verifyQuote(hash, otherId, amountStroops, currency, expiresAt, secret)).toBe(false);
  });

  it('rejects an expired quote', () => {
    const expiredAt = new Date(Date.now() - 1_000).toISOString(); // 1 s ago
    const hash = signQuote(bookingId, amountStroops, currency, expiredAt, secret);
    expect(verifyQuote(hash, bookingId, amountStroops, currency, expiredAt, secret)).toBe(false);
  });

  it('rejects empty secret', () => {
    const hash = signQuote(bookingId, amountStroops, currency, expiresAt, secret);
    expect(verifyQuote(hash, bookingId, amountStroops, currency, expiresAt, '')).toBe(false);
  });

  it('produces different hashes for different bookingIds', () => {
    const h1 = signQuote('id-1', amountStroops, currency, expiresAt, secret);
    const h2 = signQuote('id-2', amountStroops, currency, expiresAt, secret);
    expect(h1).not.toBe(h2);
  });
});

// ─── buildAmountBreakdown ────────────────────────────────────────────────────

describe('buildAmountBreakdown', () => {
  it('returns all three fields', () => {
    const breakdown = buildAmountBreakdown(10_000_000n);
    expect(breakdown).toHaveProperty('amountStroops');
    expect(breakdown).toHaveProperty('amountDisplay');
    expect(breakdown).toHaveProperty('currency');
  });

  describe('validateSignedPaymentTransaction', () => {
    const issuer = Keypair.random().publicKey();

    function buildXdr(amount: string, assetIssuer = issuer): string {
      const source = Keypair.random().publicKey();
      const destination = Keypair.random().publicKey();
      return new TransactionBuilder(new Account(source, '1'), {
        fee: '100',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.payment({
          destination,
          asset: new Asset('USDC', assetIssuer),
          amount,
        }))
        .setTimeout(30)
        .build()
        .toXDR();
    }

    it('accepts a USDC payment whose signed operation matches the quote', () => {
      vi.stubEnv('STELLAR_NETWORK', 'testnet');
      vi.stubEnv('STELLAR_USDC_ISSUER', issuer);

      expect(() => validateSignedPaymentTransaction(buildXdr('12.34'), 123_400_000n)).not.toThrow();
    });

    it('rejects an operation with a different amount', () => {
      vi.stubEnv('STELLAR_NETWORK', 'testnet');
      vi.stubEnv('STELLAR_USDC_ISSUER', issuer);

      expect(() => validateSignedPaymentTransaction(buildXdr('12.33'), 123_400_000n))
        .toThrow('Payment transaction amount does not match the signed quote');
    });

    it('rejects a USDC-like asset from an unconfigured issuer', () => {
      vi.stubEnv('STELLAR_NETWORK', 'testnet');
      vi.stubEnv('STELLAR_USDC_ISSUER', issuer);

      expect(() => validateSignedPaymentTransaction(
        buildXdr('12.34', Keypair.random().publicKey()),
        123_400_000n,
      )).toThrow('Payment transaction asset does not match configured USDC');
    });
  });

  it('amountStroops is a string (BigInt serialisation)', () => {
    const { amountStroops } = buildAmountBreakdown(10_000_000n);
    expect(typeof amountStroops).toBe('string');
    expect(amountStroops).toBe('10000000');
  });

  it('amountDisplay includes currency symbol', () => {
    const { amountDisplay } = buildAmountBreakdown(10_000_000n, 'USDC');
    expect(amountDisplay).toContain('USDC');
    expect(amountDisplay).toContain('1.00');
  });
});
