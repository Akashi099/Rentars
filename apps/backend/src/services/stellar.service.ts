/**
 * Stellar service — wraps Stellar Horizon interactions for payment transactions.
 *
 * Responsibilities:
 * - Submit signed XDR transactions to Stellar testnet/mainnet
 * - Poll Horizon for confirmation with exponential-backoff and timeout
 * - Retry logic with double-spend protection (check existing tx hash first)
 *
 * All blockchain calls are isolated here. Controllers/routes never call
 * Horizon directly.
 *
 * OAuth/passkey design note:
 * When OAuth or passkey support is added, authentication still produces a JWT
 * with { userId, role }. This service only operates on signed XDR from the
 * wallet layer and is fully independent of the auth mechanism.
 */

import { Horizon, Networks, Transaction } from '@stellar/stellar-sdk';
import { updatePaymentStatus, getPaymentStatus } from './payment.service.js';
import { usdcToStroops } from '@/utils/payment.utils.js';

const CONFIRMATION_TIMEOUT_MS = 120_000; // 2 minutes max wait (was 60 s)
/** Starting interval; doubles each attempt up to MAX_POLL_INTERVAL_MS. */
const INITIAL_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 15_000;

export type StellarNetwork = 'testnet' | 'mainnet';

interface NetworkConfig {
  network: StellarNetwork;
  passphrase: string;
  horizonUrl: string;
}

/**
 * Centralized network configuration. The active network is resolved from the
 * environment exactly once per call so that wallet, backend and Horizon all
 * agree on the same passphrase and endpoint.
 */
export function getNetworkConfig(): NetworkConfig {
  const raw = (process.env.STELLAR_NETWORK ?? 'testnet').toLowerCase();
  if (raw !== 'testnet' && raw !== 'mainnet') {
    throw new Error(`Unsupported STELLAR_NETWORK: ${raw}`);
  }
  const network = raw as StellarNetwork;
  return {
    network,
    passphrase: network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
    horizonUrl:
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org',
  };
}

function getHorizonServer(): Horizon.Server {
  return new Horizon.Server(getNetworkConfig().horizonUrl);
}

/**
 * Ensure the network the wallet signed for matches the backend's active
 * network. Throws on mismatch so a wrong-network transaction can never be
 * submitted or accepted for a booking.
 */
export function assertNetworkMatches(walletNetwork?: string): StellarNetwork {
  const { network } = getNetworkConfig();
  if (walletNetwork && walletNetwork.toLowerCase() !== network) {
    throw new Error(
      `Network mismatch: wallet is on ${walletNetwork} but backend is on ${network}`,
    );
  }
  return network;
}

/**
 * Reject signed transactions unless they contain exactly the quoted USDC
 * payment operation. The issuer is configured explicitly so an unrelated
 * asset named "USDC" cannot satisfy the quote.
 */
export function validateSignedPaymentTransaction(
  signedXdr: string,
  expectedAmountStroops: bigint,
): void {
  const { passphrase } = getNetworkConfig();
  const issuer = process.env.STELLAR_USDC_ISSUER;
  if (!issuer) throw new Error('STELLAR_USDC_ISSUER is not configured');

  const transaction = new Transaction(signedXdr, passphrase);
  if (transaction.operations.length !== 1) {
    throw new Error('Payment transaction must contain exactly one operation');
  }

  const operation = transaction.operations[0];
  if (operation?.type !== 'payment') {
    throw new Error('Payment transaction must contain a Stellar payment operation');
  }
  if (operation.asset.getCode() !== 'USDC' || operation.asset.getIssuer() !== issuer) {
    throw new Error('Payment transaction asset does not match configured USDC');
  }
  if (usdcToStroops(operation.amount) !== expectedAmountStroops) {
    throw new Error('Payment transaction amount does not match the signed quote');
  }
}

export interface SubmitResult {
  txHash: string;
  network: StellarNetwork;
}

/**
 * Submit a signed transaction XDR to Stellar Horizon.
 * Returns the transaction hash and network on success. Throws on failure.
 *
 * The transaction is parsed with the backend's active passphrase, so a
 * transaction signed for a different network fails to decode and is rejected
 * before any broadcast happens.
 */
export async function submitTransaction(
  signedXdr: string,
  walletNetwork?: string,
): Promise<SubmitResult> {
  const { network, passphrase } = getNetworkConfig();
  assertNetworkMatches(walletNetwork);

  const server = getHorizonServer();
  const tx = new Transaction(signedXdr, passphrase);
  const response = await server.submitTransaction(tx);
  return { txHash: response.hash, network };
}

/**
 * Poll Horizon with exponential backoff until the transaction is confirmed or
 * the deadline is reached.  Updates the payment record with the final status.
 *
 * Status semantics:
 *   - 'confirmed'  — tx is on-ledger and successful; payment updated once.
 *   - 'failed'     — tx is on-ledger but unsuccessful; final failure.
 *   - 'timed_out'  — deadline exceeded while tx was still not found; this is
 *                    NOT a final failure — reconciliation may still resolve it.
 *   - throws       — on a non-404 Horizon error (marks payment as 'failed').
 *
 * @returns 'confirmed' | 'failed' | 'timed_out'
 */
export async function confirmTransaction(
  paymentId: string,
  txHash: string,
): Promise<'confirmed' | 'failed' | 'timed_out'> {
  const server = getHorizonServer();
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  let interval = INITIAL_POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    try {
      const tx = await server.transactions().transaction(txHash).call();
      if (tx.successful) {
        await updatePaymentStatus(paymentId, txHash, 'confirmed');
        return 'confirmed';
      }
      // On-chain but unsuccessful (fee bump failed, etc.) — final failure.
      await updatePaymentStatus(paymentId, txHash, 'failed');
      return 'failed';
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error &&
        (err.message.includes('404') || err.message.includes('not found'));
      if (!isNotFound) {
        // Unexpected Horizon error — mark failed and surface to caller.
        await updatePaymentStatus(paymentId, txHash, 'failed');
        throw err;
      }
      // 404 = not yet on ledger; back off and keep polling.
    }

    await new Promise((r) => setTimeout(r, interval));
    // Exponential backoff — double interval up to the cap.
    interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);
  }

  // Deadline exceeded while transaction was still pending.  Mark as timed_out
  // rather than failed so the reconciliation flow can revisit it later.
  await updatePaymentStatus(paymentId, txHash, 'timed_out');
  return 'timed_out';
}

/**
 * Retry a failed or timed-out payment.
 * Double-spend protection: if a txHash already exists, re-polls it instead
 * of submitting a new transaction.
 *
 * Ambiguous outcomes (timed_out) are handed to the reconciliation path rather
 * than encouraging a blind re-broadcast: a payment that was already submitted
 * is only ever re-polled, never re-signed and re-submitted.
 */
export async function retryTransaction(
  paymentId: string,
  signedXdr?: string,
  walletNetwork?: string,
): Promise<{
  txHash: string;
  network: StellarNetwork;
  status: 'confirmed' | 'failed' | 'timed_out';
  reconciliationRequired: boolean;
}> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) throw new Error('Payment not found');

  if (!['failed', 'timed_out'].includes(payment.status)) {
    throw new Error(`Cannot retry payment in status: ${payment.status}`);
  }

  const { network } = getNetworkConfig();
  assertNetworkMatches(walletNetwork);

  let txHash: string;

  if (payment.stellar_tx_hash) {
    // Already submitted — re-poll to avoid double-spend. Never re-broadcast.
    txHash = payment.stellar_tx_hash;
  } else {
    if (!signedXdr) throw new Error('signedXdr required for payments that were never submitted');
    validateSignedPaymentTransaction(signedXdr, payment.amount_stroops);
    const result = await submitTransaction(signedXdr, walletNetwork);
    txHash = result.txHash;
    await updatePaymentStatus(paymentId, txHash, 'submitted');
  }

  const status = await confirmTransaction(paymentId, txHash);
  return {
    txHash,
    network,
    status,
    // Ambiguous outcomes must go through reconciliation, not blind retries.
    reconciliationRequired: status === 'timed_out',
  };
}
