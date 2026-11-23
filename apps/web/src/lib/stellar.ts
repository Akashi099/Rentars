import * as StellarSdk from '@stellar/stellar-sdk';

export type StellarNetwork = 'testnet' | 'mainnet';

export const STELLAR_NETWORKS = {
  testnet: {
    name: 'Testnet',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    name: 'Mainnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
  },
};

export function getNetworkConfig(network: StellarNetwork = 'testnet') {
  return STELLAR_NETWORKS[network];
}

export function getHorizonServer(network: StellarNetwork = 'testnet') {
  const config = getNetworkConfig(network);
  return new StellarSdk.Horizon.Server(config.horizonUrl);
}

/**
 * Error thrown when the connected wallet's network does not match the
 * network the backend has configured as active.
 */
export class StellarNetworkMismatchError extends Error {
  readonly expectedNetwork: StellarNetwork;
  readonly actualNetwork: StellarNetwork | null;

  constructor(expectedNetwork: StellarNetwork, actualNetwork: StellarNetwork | null) {
    const actualLabel = actualNetwork ? STELLAR_NETWORKS[actualNetwork].name : 'unknown';
    super(
      `Wallet network mismatch: the app is configured for ${STELLAR_NETWORKS[expectedNetwork].name} ` +
        `but your wallet is connected to ${actualLabel}. ` +
        `Please switch your wallet to ${STELLAR_NETWORKS[expectedNetwork].name} and try again.`,
    );
    this.name = 'StellarNetworkMismatchError';
    this.expectedNetwork = expectedNetwork;
    this.actualNetwork = actualNetwork;
  }
}

/**
 * Normalize an arbitrary network identifier (passphrase, name, or key) into
 * a known StellarNetwork, or return null if it cannot be recognized.
 */
export function normalizeNetwork(value: unknown): StellarNetwork | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === 'testnet' || lower === 'test') return 'testnet';
  if (lower === 'mainnet' || lower === 'public' || lower === 'main') return 'mainnet';

  for (const key of Object.keys(STELLAR_NETWORKS) as StellarNetwork[]) {
    const config = STELLAR_NETWORKS[key];
    if (
      trimmed === config.passphrase ||
      lower === config.name.toLowerCase() ||
      trimmed === config.horizonUrl ||
      trimmed === config.sorobanRpcUrl
    ) {
      return key;
    }
  }

  return null;
}

/**
 * Fetch the active network configuration from the backend.
 * Falls back to testnet if the backend cannot be reached, but marks the
 * result as unverified so callers can decide whether to proceed.
 */
export async function fetchActiveNetwork(): Promise<{
  network: StellarNetwork;
  verified: boolean;
}> {
  try {
    const response = await fetch('/api/v1/stellar/network', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      return { network: 'testnet', verified: false };
    }

    const data = (await response.json()) as { network?: unknown };
    const network = normalizeNetwork(data?.network);
    if (!network) {
      return { network: 'testnet', verified: false };
    }

    return { network, verified: true };
  } catch {
    return { network: 'testnet', verified: false };
  }
}

/**
 * Determine the network a wallet is currently connected to.
 * Supports the common wallet APIs (Freighter, etc.).
 */
export async function getWalletNetwork(): Promise<StellarNetwork | null> {
  const globalAny = globalThis as unknown as {
    freighter?: { getNetwork?: () => Promise<{ network?: string; networkPassphrase?: string }> };
    freighterApi?: { getNetwork?: () => Promise<{ network?: string; networkPassphrase?: string }> };
    stellar?: { getNetwork?: () => Promise<{ network?: string; networkPassphrase?: string }> };
  };

  const candidates = [globalAny.freighter, globalAny.freighterApi, globalAny.stellar];

  for (const candidate of candidates) {
    if (candidate && typeof candidate.getNetwork === 'function') {
      try {
        const result = await candidate.getNetwork();
        const network =
          normalizeNetwork(result?.network) ?? normalizeNetwork(result?.networkPassphrase);
        if (network) return network;
      } catch {
        // Try the next provider.
      }
    }
  }

  return null;
}

/**
 * Validate that the wallet's network matches the expected network.
 * Throws StellarNetworkMismatchError when they differ.
 */
export async function assertWalletNetwork(expectedNetwork: StellarNetwork): Promise<void> {
  const walletNetwork = await getWalletNetwork();

  // If the wallet does not expose its network, we cannot verify it here.
  // The backend performs a second server-side check before submission.
  if (walletNetwork === null) {
    return;
  }

  if (walletNetwork !== expectedNetwork) {
    throw new StellarNetworkMismatchError(expectedNetwork, walletNetwork);
  }
}

/**
 * Resolve the active network from the backend and verify the wallet agrees.
 * Returns the validated network so callers can use it for signing.
 */
export async function resolveAndValidateNetwork(): Promise<StellarNetwork> {
  const { network } = await fetchActiveNetwork();
  await assertWalletNetwork(network);
  return network;
}