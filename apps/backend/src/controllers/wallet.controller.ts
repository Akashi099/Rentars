import type { Request, Response } from 'express';
import { Transaction } from '@stellar/stellar-sdk';
import { WalletAuthService } from '@/services/wallet.service.js';
import { getSorobanServer, simulateTransaction } from '@/blockchain/soroban.js';

const walletAuthService = new WalletAuthService();

export async function walletChallenge(req: Request, res: Response): Promise<void> {
  const { address } = req.body;

  const result = await walletAuthService.generateChallenge(address);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function walletVerify(req: Request, res: Response): Promise<void> {
  const { address, challenge, signature } = req.body;

  const result = await walletAuthService.verifySignature(address, challenge, signature);

  if (!result.success) {
    res.status(401).json({ error: result.error });
    return;
  }

  res.json(result.data);
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
      events: result.events,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
