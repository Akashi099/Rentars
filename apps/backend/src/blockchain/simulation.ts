import type { Transaction, rpc } from '@stellar/stellar-sdk';
import { assertSimulationSafe, type SimulationResult } from './soroban.js';

export type { SimulationResult };

/**
 * Preflight a transaction and throw if the simulation shows it is not safe to sign.
 * Returns the simulation result (fee estimate, events) for callers that need it.
 */
export function simulateOrThrow(server: rpc.Server, tx: Transaction): Promise<SimulationResult> {
  return assertSimulationSafe(server, tx);
}
