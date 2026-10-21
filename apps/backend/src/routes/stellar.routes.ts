/**
 * Stellar network routes.
 *
 * GET /api/v1/stellar/network    — return active network identity (no auth required)
 * GET /api/v1/stellar/contracts  — return public contract registry metadata (no auth required)
 *
 * These endpoints are intentionally unauthenticated: the network and contract
 * IDs the app uses are not secrets, and the frontend needs them before a wallet
 * is connected.
 */

import { Router } from 'express';
import { getNetworkIdentity } from '@/controllers/network.controller.js';
import { getPublicContractInfo } from '@/blockchain/contractRegistry.js';
import type { Request, Response } from 'express';

const router = Router();

/**
 * GET /api/v1/stellar/network
 *
 * Returns { network, passphrase, rpcUrl } so clients can cross-check their
 * wallet network against the backend before signing any transaction.
 */
router.get('/network', getNetworkIdentity);

/**
 * GET /api/v1/stellar/contracts
 *
 * Returns the public contract registry: all deployed contract IDs, ABI
 * versions, WASM hashes, and compatible app ranges.
 *
 * Operators can call this endpoint to confirm which contract version is
 * live without needing access to the server environment.
 */
router.get('/contracts', (_req: Request, res: Response) => {
  res.json({ contracts: getPublicContractInfo() });
});

export default router;
