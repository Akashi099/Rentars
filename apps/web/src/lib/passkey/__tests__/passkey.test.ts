import { describe, expect, it, vi } from 'vitest';

const submitTransaction = vi.fn();
const loadAccount = vi.fn();

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn(function MockServer() {
        return { loadAccount, submitTransaction };
      }),
    },
  };
});

import * as StellarSdk from '@stellar/stellar-sdk';
import { deriveKeyFromPasskey, verifyPasskeySignature } from '../stellar';
import { deployStellarSmartWallet, getSmartWalletDetails } from '../deploy';
import { PASSKEY_WALLET_SUPPORTED, PasskeyUnsupportedError, isPasskeyUnsupportedError } from '../status';

// Stub keypair: real keypair generation fails under jsdom (cross-realm typed arrays),
// and these paths never use the key beyond its public key.
function fixedKeypair() {
  return { publicKey: () => 'GTESTPUBLICKEYFORLOOKUP' } as unknown as StellarSdk.Keypair;
}

describe('passkey wallet support', () => {
  it('is declared unsupported until a real provider exists', () => {
    expect(PASSKEY_WALLET_SUPPORTED).toBe(false);
  });

  it('deriveKeyFromPasskey rejects instead of returning a random keypair', async () => {
    const randomSpy = vi.spyOn(StellarSdk.Keypair, 'random');
    await expect(deriveKeyFromPasskey('cred-1')).rejects.toBeInstanceOf(PasskeyUnsupportedError);
    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  it('verifyPasskeySignature never accepts a signature', async () => {
    await expect(verifyPasskeySignature('cred-1', 'sig', 'data')).rejects.toBeInstanceOf(PasskeyUnsupportedError);
  });

  it('deployStellarSmartWallet fails before any network call', async () => {
    const keypair = fixedKeypair();
    await expect(deployStellarSmartWallet(keypair, 'testnet')).rejects.toMatchObject({ code: 'PASSKEY_UNSUPPORTED' });
    expect(loadAccount).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it('exposes a typed guard for callers to offer a fallback', () => {
    expect(isPasskeyUnsupportedError(new PasskeyUnsupportedError('x'))).toBe(true);
    expect(isPasskeyUnsupportedError(new Error('other'))).toBe(false);
  });

  it('keeps read-only wallet lookups working', async () => {
    loadAccount.mockResolvedValueOnce({ balances: [], sequence: '42' });
    const details = await getSmartWalletDetails(fixedKeypair().publicKey(), 'testnet');
    expect(details.sequenceNumber).toBe('42');
  });
});
