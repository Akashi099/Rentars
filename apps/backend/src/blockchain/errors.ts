/**
 * Structured blockchain error codes. These are the stable identifiers that the
 * shared payment error taxonomy maps from; they must never carry raw XDR,
 * signed envelopes, secret keys, or other sensitive material.
 */
export type BlockchainErrorCode =
  | 'BLOCKCHAIN_ERROR'
  | 'CONTRACT_ERROR'
  | 'TRANSACTION_ERROR'
  | 'AVAILABILITY_ERROR'
  | 'SIMULATION_ERROR'
  | 'QUOTE_INVALIDATED'
  | 'WALLET_REJECTED'
  | 'INSUFFICIENT_FUNDS'
  | 'RPC_FAILURE'
  | 'PROVIDER_TIMEOUT'
  | 'CONTRACT_REJECTION'
  | 'CONFIRMED_FAILURE';

export class BlockchainError extends Error {
  readonly code: BlockchainErrorCode;

  constructor(message: string, code: BlockchainErrorCode = 'BLOCKCHAIN_ERROR') {
    super(message);
    this.name = 'BlockchainError';
    this.code = code;
  }
}

export class ContractError extends BlockchainError {
  constructor(
    message: string,
    public readonly contractMethod?: string,
  ) {
    super(message, 'CONTRACT_ERROR');
    this.name = 'ContractError';
  }
}

/**
 * The contract executed but rejected the operation (e.g. failed an assertion).
 * Distinct from a generic contract error so the taxonomy can offer safe
 * next steps without implying the payment succeeded.
 */
export class ContractRejectionError extends BlockchainError {
  constructor(
    message: string,
    public readonly contractMethod?: string,
  ) {
    super(message, 'CONTRACT_REJECTION');
    this.name = 'ContractRejectionError';
  }
}

export class TransactionError extends BlockchainError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

/**
 * A transaction was submitted and reached a terminal failed state on-chain.
 * Resubmission is unsafe; callers must not retry automatically.
 */
export class ConfirmedFailureError extends BlockchainError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'CONFIRMED_FAILURE');
    this.name = 'ConfirmedFailureError';
  }
}

export class AvailabilityError extends BlockchainError {
  constructor(message: string) {
    super(message, 'AVAILABILITY_ERROR');
    this.name = 'AvailabilityError';
  }
}

/** The user rejected the request in their wallet. Safe to retry manually. */
export class WalletRejectedError extends BlockchainError {
  constructor(message = 'Transaction was rejected in the wallet') {
    super(message, 'WALLET_REJECTED');
    this.name = 'WalletRejectedError';
  }
}

/** The account lacks funds for the transaction. */
export class InsufficientFundsError extends BlockchainError {
  constructor(message = 'Insufficient funds for this transaction') {
    super(message, 'INSUFFICIENT_FUNDS');
    this.name = 'InsufficientFundsError';
  }
}

/** The RPC endpoint returned an error or was unreachable. */
export class RpcFailureError extends BlockchainError {
  constructor(message = 'Blockchain RPC request failed') {
    super(message, 'RPC_FAILURE');
    this.name = 'RpcFailureError';
  }
}

/** The provider did not respond within the allotted time. */
export class ProviderTimeoutError extends BlockchainError {
  constructor(message = 'Blockchain provider timed out') {
    super(message, 'PROVIDER_TIMEOUT');
    this.name = 'ProviderTimeoutError';
  }
}

export class EscrowError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'EscrowError';
  }
}

export interface SimulationDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly contractMethod?: string;
  readonly recoverable: boolean;
}

export interface FeeEstimation {
  readonly baseFee: string;
  readonly resourceFee: string;
  readonly totalFee: string;
  readonly minResourceFee?: string;
  readonly maxResourceFee?: string;
  readonly currency: string;
}

export interface SimulationResult {
  readonly success: boolean;
  readonly fee: FeeEstimation;
  readonly diagnostics: readonly SimulationDiagnostic[];
  readonly ledger: number;
  readonly expiresAt: number;
}

export class SimulationError extends BlockchainError {
  constructor(
    message: string,
    public readonly diagnostics: readonly SimulationDiagnostic[] = [],
  ) {
    super(message, 'SIMULATION_ERROR');
    this.name = 'SimulationError';
  }
}

export class QuoteInvalidatedError extends BlockchainError {
  constructor(message = 'Quote changed; previous simulation is no longer valid') {
    super(message, 'QUOTE_INVALIDATED');
    this.name = 'QuoteInvalidatedError';
  }
}

/**
 * Redacts potentially sensitive material (raw XDR, signed envelopes, secret
 * keys) from an error message before it is surfaced to users or logs.
 */
export function sanitizeBlockchainErrorMessage(message: string): string {
  return message
    .replace(/S[A-Z2-7]{55}/g, '[redacted-secret]')
    .replace(/(?:AAAAA[A-Za-z0-9+/=]{20,}|[A-Za-z0-9+/=]{100,})/g, '[redacted-xdr]');
}

/**
 * Maps an arbitrary thrown value to a structured blockchain error code without
 * leaking raw payloads. Used by the shared payment error taxonomy.
 */
export function classifyBlockchainError(error: unknown): BlockchainErrorCode {
  if (error instanceof BlockchainError) {
    return error.code;
  }
  const message = sanitizeBlockchainErrorMessage(
    error instanceof Error ? error.message : String(error ?? ''),
  ).toLowerCase();
  if (message.includes('user rejected') || message.includes('rejected by user')) {
    return 'WALLET_REJECTED';
  }
  if (message.includes('insufficient') || message.includes('underfunded')) {
    return 'INSUFFICIENT_FUNDS';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'PROVIDER_TIMEOUT';
  }
  if (message.includes('rpc') || message.includes('network')) {
    return 'RPC_FAILURE';
  }
  if (message.includes('contract') && message.includes('reject')) {
    return 'CONTRACT_REJECTION';
  }
  return 'BLOCKCHAIN_ERROR';
}
