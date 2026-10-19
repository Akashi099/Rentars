/**
 * Blockchain/Stellar RPC instrumentation for distributed tracing.
 *
 * Wraps Soroban RPC calls and contract invocations to create child spans.
 */

import { startSpan, endSpan, addSpanAttribute, addSpanEvent, recordSpanError, SpanKind } from '@/config/tracing.js';

interface RpcCallOptions {
  method: string;
  contractId?: string;
  functionName?: string;
}

export async function tracedRpcCall<T>(
  options: RpcCallOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const span = startSpan(`stellar.rpc.${options.method}`, SpanKind.CLIENT, {
    'rpc.system': 'stellar-soroban',
    'rpc.method': options.method,
    'stellar.contract_id': options.contractId ?? '',
    'stellar.function': options.functionName ?? '',
  });

  addSpanEvent('rpc.call.start', { method: options.method, contractId: options.contractId });

  try {
    const result = await fn();
    addSpanEvent('rpc.call.end', { method: options.method, success: true });
    endSpan(span);
    return result;
  } catch (err) {
    recordSpanError(err instanceof Error ? err : new Error(String(err)));
    addSpanEvent('rpc.call.error', { method: options.method, error: String(err) });
    endSpan(span, { code: 'error', message: String(err) });
    throw err;
  }
}

export async function tracedContractCall<T>(
  contractId: string,
  functionName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracedRpcCall(
    { method: 'invokeContract', contractId, functionName },
    fn,
  );
}

export async function tracedSimulateTransaction<T>(
  contractId: string,
  functionName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracedRpcCall(
    { method: 'simulateTransaction', contractId, functionName },
    fn,
  );
}

export async function tracedSendTransaction<T>(
  contractId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracedRpcCall(
    { method: 'sendTransaction', contractId },
    fn,
  );
}

export async function tracedGetTransaction<T>(
  txHash: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracedRpcCall(
    { method: 'getTransaction', functionName: txHash },
    fn,
  );
}

export async function tracedGetEvents<T>(
  contractId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return tracedRpcCall(
    { method: 'getEvents', contractId },
    fn,
  );
}

export function addStellarAttributes(attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    addSpanAttribute(`stellar.${key}`, value);
  }
}