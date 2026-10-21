/**
 * Network identity controller.
 *
 * Exposes a non-sensitive endpoint that lets the frontend (and operators)
 * confirm which Stellar network the backend is configured for.  This is the
 * server-side half of the network-mismatch guard: the frontend compares
 * NEXT_PUBLIC_STELLAR_NETWORK against the value returned here before allowing
 * any payment flow to proceed.
 *
 * No secrets are returned — only the network name, network passphrase
 * (already public knowledge), and RPC URL (non-sensitive config).
 */

import type { Request, Response } from 'express';
import { env } from '@/config/env.js';
import { NETWORK_PASSPHRASE, STELLAR_RPC_URL } from '@/blockchain/config.js';

/**
 * GET /api/v1/stellar/network
 *
 * Returns the backend's active Stellar network configuration so clients can
 * detect a mismatch before signing or submitting transactions.
 *
 * Response (200):
 * {
 *   network: 'testnet' | 'mainnet',
 *   passphrase: string,   // public network passphrase — not a secret
 *   rpcUrl: string
 * }
 */
export function getNetworkIdentity(_req: Request, res: Response): void {
  res.json({
    network: env.STELLAR_NETWORK,
    passphrase: NETWORK_PASSPHRASE,
    rpcUrl: STELLAR_RPC_URL,
  });
}

/**
 * Validate that a client-supplied network string matches the backend
 * configuration.  Used by payment and escrow controllers to reject
 * cross-network submissions before broadcast.
 *
 * @throws never — returns a boolean; the caller decides how to handle a
 *   mismatch so that error responses stay consistent with each controller's
 *   style.
 */
export function isNetworkMatch(clientNetwork: string): boolean {
  return clientNetwork === env.STELLAR_NETWORK;
}
