'use client';

import { useCallback, useState } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getNetworkPassphrase, STELLAR_NETWORKS, getExplorerUrl } from '@/lib/network-utils';
import { signWithFreighter, FreighterError } from '@/lib/freighter-utils';
import {
  buildEscrowFundingTransaction,
  buildEscrowReleaseTransaction,
} from '@/lib/stellar-transactions';
import {
  PaymentErrorCategory,
  PaymentErrorInfo,
  PaymentAction,
  PaymentTxPhase,
  classifyPaymentError,
  getAllowedActions,
  isResubmissionSafe,
} from '@/lib/payment-errors';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const DEFAULT_SIGNING_TIMEOUT = 60000; // 60 seconds

export type EscrowTxType = 'fund' | 'release';
export type EscrowTxStatus = 'idle' | 'waiting_signature' | 'submitting' | 'success' | 'error' | 'timeout';

export interface EscrowTransactionResult {
  txHash: string;
  explorerUrl: string;
}

export interface EscrowTransactionError extends PaymentErrorInfo {
  /** Raw error for logging; never render directly to users. */
  cause?: unknown;
}

async function submitXdrToHorizon(xdr: string, network: 'testnet' | 'mainnet') {
  const passphrase = getNetworkPassphrase(network);
  const tx = StellarSdk.Transaction.fromXDR(xdr, passphrase);
  const client = new StellarSdk.Horizon.Server(
    network === 'mainnet'
      ? STELLAR_NETWORKS.mainnet.horizonUrl
      : STELLAR_NETWORKS.testnet.horizonUrl,
  );

  const result = await client.submitTransaction(tx);
  return result.hash;
}

export function useEscrowTransaction(network: 'testnet' | 'mainnet' = 'testnet') {
  const [status, setStatus] = useState<EscrowTxStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<EscrowTransactionError | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [allowedActions, setAllowedActions] = useState<PaymentAction[]>([]);
  const [txPhase, setTxPhase] = useState<PaymentTxPhase>('unsigned');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);

  const submit = useCallback(
    async (params: {
      type: EscrowTxType;
      escrowId: string;
      amount?: string | number;
      tenantPublicKey?: string;
      ownerPublicKey?: string;
      signingTimeout?: number;
    }): Promise<EscrowTransactionResult> => {
      const {
        type,
        escrowId,
        amount,
        tenantPublicKey,
        ownerPublicKey,
        signingTimeout = DEFAULT_SIGNING_TIMEOUT,
      } = params;

      setStatus('idle');
      setError(null);
      setErrorInfo(null);
      setCanRetry(false);
      setAllowedActions([]);
      setTxPhase('unsigned');

      // Retain idempotency context across retries so a retried payment is
      // never duplicated server-side.
      const requestKey = `${type}:${escrowId}:${String(amount ?? '0')}`;
      setIdempotencyKey(requestKey);

      let phase: PaymentTxPhase = 'unsigned';

      try {
        const { xdr } =
          type === 'fund'
            ? buildEscrowFundingTransaction(
                escrowId,
                amount ?? '0',
                tenantPublicKey ?? '',
                network,
              )
            : buildEscrowReleaseTransaction(
                escrowId,
                ownerPublicKey ?? '',
                network,
              );

        // Sign via Freighter with timeout
        setStatus('waiting_signature');
        phase = 'signing';
        setTxPhase(phase);
        const signedXdr = await signWithFreighter(xdr, network, { timeout: signingTimeout });

        // Once signed, the transaction must never be resubmitted blindly.
        phase = 'signed';
        setTxPhase(phase);

        // Submit to Stellar network
        setStatus('submitting');
        phase = 'submitted';
        setTxPhase(phase);
        const txHash = await submitXdrToHorizon(signedXdr, network);
        phase = 'confirmed';
        setTxPhase(phase);

        // Notify backend
        if (type === 'fund') {
          await fetch(`${API_URL}/api/v1/bookings/escrow/${escrowId}/fund`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount: String(amount ?? '0'),
              txHash,
            }),
          });
        } else {
          await fetch(`${API_URL}/api/v1/bookings/escrow/${escrowId}/release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reason: 'Release signed by owner',
              txHash,
            }),
          });
        }

        setStatus('success');
        setTxPhase('confirmed');
        return {
          txHash,
          explorerUrl: getExplorerUrl(txHash, network),
        };
      } catch (err) {
        const info = classifyPaymentError(err, phase);
        const actions = getAllowedActions(info.category, phase);
        const retrySafe = isResubmissionSafe(phase) && actions.includes('retry');

        setStatus(info.category === PaymentErrorCategory.TIMEOUT ? 'timeout' : 'error');
        setError(info.message);
        setErrorInfo({ ...info, cause: err });
        setAllowedActions(actions);
        setCanRetry(retrySafe);
        setTxPhase(phase);

        throw err;
      }
    },
    [network],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setErrorInfo(null);
    setCanRetry(false);
    setAllowedActions([]);
    setTxPhase('unsigned');
    setIdempotencyKey(null);
  }, []);

  return {
    submit,
    status,
    error,
    errorCategory: errorInfo?.category ?? null,
    errorInfo,
    canRetry,
    allowedActions,
    txPhase,
    idempotencyKey,
    reset,
    isSubmitting: status === 'waiting_signature' || status === 'submitting',
  };
}

