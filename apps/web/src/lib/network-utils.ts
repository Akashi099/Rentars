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

export function getNetworkConfig(network: 'testnet' | 'mainnet' = 'testnet') {
  return STELLAR_NETWORKS[network];
}

export function getNetworkPassphrase(network: 'testnet' | 'mainnet' = 'testnet'): string {
  return STELLAR_NETWORKS[network].passphrase;
}

/**
 * Get the expected network from environment configuration
 */
export function getExpectedNetwork(): 'testnet' | 'mainnet' {
  const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
  return network === 'mainnet' ? 'mainnet' : 'testnet';
}

/**
 * Get the block explorer URL for a transaction
 */
export function getExplorerUrl(txHash: string, network: 'testnet' | 'mainnet'): string {
  const base =
    network === 'mainnet'
      ? 'https://stellar.expert/explorer/public/tx/'
      : 'https://stellar.expert/explorer/testnet/tx/';
  return `${base}${txHash}`;
}

// ─── Backend network cross-check ─────────────────────────────────────────────

export interface BackendNetworkInfo {
  network: 'testnet' | 'mainnet';
  passphrase: string;
  rpcUrl: string;
}

/**
 * Fetch the backend's active Stellar network configuration.
 * Used to cross-check wallet ↔ backend network before signing.
 *
 * @throws Error if the request fails or the response is malformed.
 */
export async function fetchBackendNetwork(apiUrl: string): Promise<BackendNetworkInfo> {
  const res = await fetch(`${apiUrl}/api/v1/stellar/network`);
  if (!res.ok) {
    throw new Error(`Failed to fetch backend network info: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data?.network || (data.network !== 'testnet' && data.network !== 'mainnet')) {
    throw new Error('Unexpected network response from backend');
  }
  return data as BackendNetworkInfo;
}

/**
 * Validate that the wallet network, the frontend env config, and the backend
 * all agree on the same Stellar network.
 *
 * Returns `null` when all three agree, or a human-readable mismatch description
 * when they diverge.  Never throws — network errors are treated as a mismatch
 * to fail safely.
 *
 * This function should be called:
 *   1. When the wallet connects.
 *   2. Before building or signing any payment intent.
 *   3. Before submitting a signed transaction to the backend.
 */
export async function validateNetworkConsistency(
  walletNetwork: 'testnet' | 'mainnet',
  apiUrl: string,
): Promise<string | null> {
  const frontendNetwork = getExpectedNetwork();

  if (walletNetwork !== frontendNetwork) {
    return `Wallet is on ${walletNetwork} but the app is configured for ${frontendNetwork}. Switch your Freighter account to the correct network.`;
  }

  try {
    const backend = await fetchBackendNetwork(apiUrl);
    if (backend.network !== frontendNetwork) {
      return `The server is configured for ${backend.network} but the app expects ${frontendNetwork}. Contact support.`;
    }
  } catch {
    // Network request failed — treat as mismatch: fail safely.
    return 'Could not verify the server network. Please try again.';
  }

  return null; // all three agree
}
