import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  signUSDCPaymentTransaction,
  signEscrowFundingTransaction,
  signEscrowReleaseTransaction,
  verifySignedTransaction,
  getUSDCBalance,
} from '../wallet.service';
import * as freighterUtils from '@/lib/freighter-utils';
import * as StellarSdk from '@stellar/stellar-sdk';

// Mock dependencies
vi.mock('@/lib/freighter-utils', () => ({
  signWithFreighter: vi.fn(),
  getNetworkPassphrase: vi.fn((network) =>
    network === 'mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015'
  ),
  FreighterError: class FreighterError extends Error {
    constructor(message: string, code: string = 'NETWORK_ERROR') {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('@/lib/stellar', () => ({
  getHorizonServer: vi.fn(),
}));

import { getHorizonServer } from '@/lib/stellar';

describe('wallet.service', () => {
  const mockPublicKey = StellarSdk.StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
  const mockRecipientKey = StellarSdk.StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(2));
  const mockSignedXdr = 'signed-xdr-value';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_USDC_ISSUER', mockRecipientKey);
  });

  afterEach(() => vi.unstubAllEnvs());

  describe('signUSDCPaymentTransaction', () => {
    it('signs USDC payment transaction successfully', async () => {
      const mockAccount = new StellarSdk.Account(mockPublicKey, '1');

      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(mockAccount),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      vi.mocked(freighterUtils.signWithFreighter).mockResolvedValue(mockSignedXdr);

      const result = await signUSDCPaymentTransaction(
        mockPublicKey,
        mockRecipientKey,
        '100',
        'testnet'
      );

      expect(result.signedXdr).toBe(mockSignedXdr);
      expect(result.transactionHash).toBeDefined();
      expect(freighterUtils.signWithFreighter).toHaveBeenCalled();
    });

    it('throws error on signing failure', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(new StellarSdk.Account(mockPublicKey, '1')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      vi.mocked(freighterUtils.signWithFreighter).mockRejectedValue(
        new Error('Signing failed')
      );

      await expect(
        signUSDCPaymentTransaction(mockPublicKey, mockRecipientKey, '100', 'testnet')
      ).rejects.toThrow(/failed to sign usdc payment/i);
    });

    it('throws error on network error', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);

      await expect(
        signUSDCPaymentTransaction(mockPublicKey, mockRecipientKey, '100', 'testnet')
      ).rejects.toThrow();
    });

    it('uses mainnet configuration', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(new StellarSdk.Account(mockPublicKey, '1')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      vi.mocked(freighterUtils.signWithFreighter).mockResolvedValue(mockSignedXdr);

      await signUSDCPaymentTransaction(mockPublicKey, mockRecipientKey, '100', 'mainnet');

      expect(getHorizonServer).toHaveBeenCalledWith('mainnet');
    });
  });

  describe('signEscrowFundingTransaction', () => {
    it('signs escrow funding transaction successfully', async () => {
      const mockAccount = new StellarSdk.Account(mockPublicKey, '1');

      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(mockAccount),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      vi.mocked(freighterUtils.signWithFreighter).mockResolvedValue(mockSignedXdr);

      const result = await signEscrowFundingTransaction(
        mockPublicKey,
        'escrow-id-123',
        '500',
        'testnet'
      );

      expect(result.signedXdr).toBe(mockSignedXdr);
      expect(result.transactionHash).toBeDefined();
    });

    it('handles user rejection', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(new StellarSdk.Account(mockPublicKey, '1')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      const rejectionError = new (freighterUtils as any).FreighterError(
        'User rejected',
        'USER_REJECTED'
      );
      vi.mocked(freighterUtils.signWithFreighter).mockRejectedValue(rejectionError);

      await expect(
        signEscrowFundingTransaction(mockPublicKey, 'escrow-id-123', '500', 'testnet')
      ).rejects.toThrow(/transaction signing rejected by user/i);
    });
  });

  describe('signEscrowReleaseTransaction', () => {
    it('signs escrow release transaction successfully', async () => {
      const mockAccount = new StellarSdk.Account(mockPublicKey, '1');

      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(mockAccount),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      vi.mocked(freighterUtils.signWithFreighter).mockResolvedValue(mockSignedXdr);

      const result = await signEscrowReleaseTransaction(
        mockPublicKey,
        'escrow-id-123',
        'testnet'
      );

      expect(result.signedXdr).toBe(mockSignedXdr);
      expect(result.transactionHash).toBeDefined();
    });

    it('handles user rejection on release', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue(new StellarSdk.Account(mockPublicKey, '1')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);
      const rejectionError = new (freighterUtils as any).FreighterError(
        'User rejected',
        'USER_REJECTED'
      );
      vi.mocked(freighterUtils.signWithFreighter).mockRejectedValue(rejectionError);

      await expect(
        signEscrowReleaseTransaction(mockPublicKey, 'escrow-id-123', 'testnet')
      ).rejects.toThrow(/transaction signing rejected by user/i);
    });
  });

  describe('verifySignedTransaction', () => {
    it('returns true for valid signed transaction', async () => {
      const validXdr = StellarSdk.TransactionBuilder.fromXDR(
        new StellarSdk.TransactionBuilder(
          new StellarSdk.Account(mockPublicKey, '0'),
          {
            fee: '100',
            networkPassphrase: 'Test SDF Network ; September 2015',
          }
        )
          .setTimeout(30)
          .build()
          .toXDR(),
        'Test SDF Network ; September 2015'
      ).toXDR();

      const result = await verifySignedTransaction(validXdr, 'testnet');

      expect(result).toBe(true);
    });

    it('returns false for invalid XDR', async () => {
      const result = await verifySignedTransaction('invalid-xdr', 'testnet');

      expect(result).toBe(false);
    });
  });

  describe('getUSDCBalance', () => {
    it('returns USDC balance', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue({
          balances: [
            { asset_code: 'native', balance: '10' },
            { asset_code: 'USDC', balance: '100.50' },
          ],
        }),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);

      const result = await getUSDCBalance(mockPublicKey, 'testnet');

      expect(result).toBe('100.50');
    });

    it('returns 0 when no USDC balance found', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockResolvedValue({
          balances: [{ asset_code: 'native', balance: '10' }],
        }),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);

      const result = await getUSDCBalance(mockPublicKey, 'testnet');

      expect(result).toBe('0');
    });

    it('returns 0 on error', async () => {
      const mockServer = {
        loadAccount: vi.fn().mockRejectedValue(new Error('Network error')),
      };

      vi.mocked(getHorizonServer).mockReturnValue(mockServer as any);

      const result = await getUSDCBalance(mockPublicKey, 'testnet');

      expect(result).toBe('0');
    });
  });
});