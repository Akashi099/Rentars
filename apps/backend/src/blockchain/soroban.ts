import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { BASE_FEE, NETWORK_PASSPHRASE, STELLAR_RPC_URL } from './config.js';
import { TransactionError } from './errors.js';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 30;

const SIMULATION_CACHE_TTL_MS = 5000;

export function getSorobanServer(): rpc.Server {
  return new rpc.Server(STELLAR_RPC_URL, {
    allowHttp: STELLAR_RPC_URL.startsWith('http://'),
  });
}

const RPC_HEALTH_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Stellar RPC health check timed out')), ms);
    }),
  ]);
}

/**
 * Verify Stellar RPC connectivity with a bounded-time getHealth() probe.
 *
 * @returns true if the RPC endpoint reports "healthy" within the timeout, false otherwise
 */
export async function getRpcHealth(): Promise<boolean> {
  try {
    const server = getSorobanServer();
    const health = await withTimeout(server.getHealth(), RPC_HEALTH_TIMEOUT_MS);
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Submit a signed Soroban transaction and poll until it is confirmed.
 */
export async function submitAndWait(
  server: rpc.Server,
  tx: Transaction,
): Promise<rpc.Api.GetTransactionResponse> {
  const sendResponse = await server.sendTransaction(tx);

  if (sendResponse.status === 'ERROR') {
    const detail =
      sendResponse.errorResult?.toXDR('base64') ?? 'unknown error';
    throw new TransactionError(`Transaction submission failed: ${detail}`);
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const getResponse = await server.getTransaction(sendResponse.hash);

    if (getResponse.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (getResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new TransactionError(
          'Transaction failed on-chain',
          sendResponse.hash,
        );
      }
      return getResponse;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new TransactionError(
    `Transaction not confirmed after ${MAX_POLL_ATTEMPTS} attempts`,
    sendResponse.hash,
  );
}

/**
 * Wrap an inner transaction in a fee-bump and sign with the fee-source keypair.
 */
export function buildFeeBump(
  innerTx: Transaction,
  feeSourceKeypair: Keypair,
): FeeBumpTransaction {
  const bumpFee = String(Math.max(200, Number(BASE_FEE) * 10));
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceKeypair,
    bumpFee,
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBump.sign(feeSourceKeypair);
  return feeBump;
}

/**
 * Simulate a read-only contract call and return the result ScVal.
 */
export async function simulateReadOnly(
  server: rpc.Server,
  tx: Transaction,
  methodName: string,
): Promise<xdr.ScVal> {
  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new TransactionError(
      `Simulation failed for ${methodName}: ${(simResult as rpc.Api.SimulateTransactionErrorResponse).error}`,
    );
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  if (!success.result?.retval) {
    throw new TransactionError(`No return value from ${methodName}`);
  }

  return success.result.retval;
}

/**
 * Result of a preflight simulation, including estimated fee and diagnostics.
 */
export interface SimulationResult {
  success: boolean;
  estimatedFee: string;
  minResourceFee: string;
  latestLedger: number;
  error?: string;
  recoverable?: boolean;
  events?: string[];
}

interface SimulationCacheEntry {
  result: SimulationResult;
  ledger: number;
  expiresAt: number;
}

const simulationCache = new Map<string, SimulationCacheEntry>();

/**
 * Derive a stable cache key from a transaction's intent (source, ops, seq).
 */
function simulationCacheKey(tx: Transaction): string {
  const ops = tx.operations
    .map((op) => JSON.stringify(op))
    .join('|');
  return `${tx.source}|${tx.sequence}|${ops}`;
}

/**
 * Parse simulation diagnostics into a safe, non-throwing summary.
 */
function parseSimulationDiagnostics(
  simResult: rpc.Api.SimulateTransactionResponse,
): { error?: string; recoverable: boolean } {
  if (!rpc.Api.isSimulationError(simResult)) {
    return { recoverable: false };
  }

  const errResponse = simResult as rpc.Api.SimulateTransactionErrorResponse;
  const raw = errResponse.error ?? 'unknown simulation error';

  // Contract errors are typically recoverable (e.g. insufficient balance,
  // authorization failures) and should be surfaced to the user preflight.
  const recoverable =
    /contract|auth|balance|trustline|allowance/i.test(raw) ||
    errResponse.events?.some((e) => e.type === 'contract') === true;

  return { error: raw, recoverable };
}

/**
 * Simulate a transaction to estimate fees and surface preflight failures.
 *
 * Results are cached briefly by transaction intent and invalidated when the
 * latest ledger advances or the transaction inputs change.
 */
export async function simulateTransaction(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const key = simulationCacheKey(tx);
  const now = Date.now();
  const cached = simulationCache.get(key);

  if (cached && cached.expiresAt > now) {
    try {
      const latest = await server.getLatestLedger();
      if (latest.sequence === cached.ledger) {
        return cached.result;
      }
    } catch {
      // Fall through to re-simulate if ledger lookup fails.
    }
  }

  let latestLedger = 0;
  try {
    const latest = await server.getLatestLedger();
    latestLedger = latest.sequence;
  } catch {
    latestLedger = 0;
  }

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    const { error, recoverable } = parseSimulationDiagnostics(simResult);
    const result: SimulationResult = {
      success: false,
      estimatedFee: '0',
      minResourceFee: '0',
      latestLedger,
      error,
      recoverable,
    };
    simulationCache.set(key, {
      result,
      ledger: latestLedger,
      expiresAt: now + SIMULATION_CACHE_TTL_MS,
    });
    return result;
  }

  const success = simResult as rpc.Api.SimulateTransactionSuccessResponse;
  const minResourceFee = success.minResourceFee ?? '0';
  const estimatedFee = String(
    Number(BASE_FEE) + Number(minResourceFee),
  );

  const result: SimulationResult = {
    success: true,
    estimatedFee,
    minResourceFee,
    latestLedger,
    events: success.events?.map((e) => e.type) ?? [],
  };

  simulationCache.set(key, {
    result,
    ledger: latestLedger,
    expiresAt: now + SIMULATION_CACHE_TTL_MS,
  });

  return result;
}

/**
 * Simulate a transaction and throw if it is not safe to sign.
 *
 * Prevents signing obviously invalid operations by failing fast on
 * unrecoverable simulation errors.
 */
export async function assertSimulationSafe(
  server: rpc.Server,
  tx: Transaction,
): Promise<SimulationResult> {
  const result = await simulateTransaction(server, tx);

  if (!result.success) {
    throw new TransactionError(
      `Preflight simulation failed: ${result.error ?? 'unknown error'}`,
    );
  }

  return result;
}

/**
 * Build a transaction from a source account for simulation purposes.
 */
export function buildSimulationTransaction(
  sourceAccount: Account,
  operations: xdr.Operation[],
  fee = BASE_FEE,
): Transaction {
  const builder = new TransactionBuilder(sourceAccount, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of operations) {
    builder.addOperation(op);
  }

  return builder.setTimeout(30).build();
}

/**
 * Clear cached simulation results, e.g. when a quote changes.
 */
export function invalidateSimulationCache(): void {
  simulationCache.clear();
}
