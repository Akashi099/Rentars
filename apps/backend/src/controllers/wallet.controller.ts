import type { Request, Response } from 'express';
import { Transaction } from '@stellar/stellar-sdk';
import { WalletAuthService } from '@/services/wallet.service.js';
import { getSorobanServer, simulateTransaction } from '@/blockchain/soroban.js';
import type { AuthRequest } from '@/middleware/auth.middleware.js';

const walletAuthService = new WalletAuthService();

function sendFailure(res: Response, result: { error?: string; code?: string; statusCode?: number }, fallback: number) {
  res.status(result.statusCode ?? fallback).json({ error: result.error, code: result.code });
}

export async function walletChallenge(req: Request, res: Response): Promise<void> {
  const { address } = req.body;

  const result = await walletAuthService.generateChallenge(address);

  if (!result.success) {
    sendFailure(res, result, 400);
    return;
  }

  res.json(result.data);
}

export async function walletVerify(req: Request, res: Response): Promise<void> {
  const { address, challenge, signature } = req.body;

  const result = await walletAuthService.verifySignature(address, challenge, signature);

  if (!result.success) {
    sendFailure(res, result, 401);
    return;
  }

  res.json(result.data);
}

/** POST /auth/wallet/link/challenge — authenticated. Issues a link challenge bound to the caller. */
export async function walletLinkChallenge(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthRequest).userId;
  const { address } = req.body;

  const result = await walletAuthService.generateChallenge(address, { purpose: 'link', userId });

  if (!result.success) {
    sendFailure(res, result, 400);
    return;
  }

  res.json(result.data);
}

/** POST /auth/wallet/link — authenticated. Requires a fresh signed link challenge. */
export async function walletLink(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthRequest).userId;
  const { address, challenge, signature } = req.body;

  const result = await walletAuthService.verifySignature(address, challenge, signature, { purpose: 'link', userId });

  if (!result.success) {
    sendFailure(res, result, 401);
    return;
  }

  res.json({ message: 'Wallet linked.', address: result.data?.address });
}

/** POST /auth/wallet/unlink/challenge — authenticated. Issues an unlink challenge for the linked wallet. */
export async function walletUnlinkChallenge(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthRequest).userId as string;

  const result = await walletAuthService.generateUnlinkChallenge(userId);

  if (!result.success) {
    sendFailure(res, result, 409);
    return;
  }

  res.json(result.data);
}

/** POST /auth/wallet/unlink — authenticated. Requires a fresh signed unlink challenge. */
export async function walletUnlink(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthRequest).userId;
  const { address, challenge, signature } = req.body;

  const result = await walletAuthService.verifySignature(address, challenge, signature, { purpose: 'unlink', userId });

  if (!result.success) {
    sendFailure(res, result, 401);
    return;
  }

  res.json({ message: 'Wallet unlinked.' });
}

/**
 * Preflight simulation endpoint. Accepts an unsigned transaction XDR (base64)
 * and returns a fee estimate and diagnostics without signing or submitting.
 */
export async function walletSimulate(req: Request, res: Response): Promise<void> {
  const { transactionXDr } = req.body as { transactionXDr?: string };

  if (!transactionXDr || typeof transactionXDr !== 'string') {
    res.status(400).json({ error: 'transactionXDr is required' });
    return;
  }

  let tx: Transaction;
  try {
    tx = new Transaction(transactionXDr, process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test Stellar Network ; December 2015');
  } catch {
    res.status(400).json({ error: 'Invalid transaction XDR' });
    return;
  }

  try {
    const result = await simulateTransaction(getSorobanServer(), tx);
    res.json({
      success: result.success,
      estimatedFeeStroops: result.estimatedFee,
      minResourceFeeStroops: result.minResourceFee,
      latestLedger: result.latestLedger,
      events: result.events,
      error: result.error,
      errorClass: result.errorClass,
      recoverable: result.recoverable,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
