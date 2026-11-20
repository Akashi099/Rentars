import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetworkConfig } from '@/lib/stellar';
import { PasskeyUnsupportedError } from './status';

/**
 * Deploy a passkey-controlled smart wallet.
 *
 * Not implemented. The previous placeholder built a memo-only transaction, signed
 * it with a random keypair and submitted it to the network, which could report a
 * "deployed" wallet that does not exist. This rejects before any network call.
 */
export async function deployStellarSmartWallet(
  _keypair: StellarSdk.Keypair,
  _network: 'testnet' | 'mainnet' = 'testnet',
): Promise<string> {
  throw new PasskeyUnsupportedError('wallet deployment');
}

/**
 * Read-only account lookup used by the wallet UI. Unaffected by the passkey gap.
 */
export async function getSmartWalletDetails(
  publicKey: string,
  network: 'testnet' | 'mainnet' = 'testnet',
): Promise<{ publicKey: string; balance: unknown; sequenceNumber: string }> {
  const config = getNetworkConfig(network);
  const server = new StellarSdk.Horizon.Server(config.horizonUrl);

  try {
    const account = await server.loadAccount(publicKey);
    return {
      publicKey,
      balance: account.balances,
      sequenceNumber: account.sequence,
    };
  } catch (error) {
    throw new Error(`Failed to get wallet details: ${error}`);
  }
}
