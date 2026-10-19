export class BlockchainError extends Error {
  readonly code: string;

  constructor(message: string, code = 'BLOCKCHAIN_ERROR') {
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

export class TransactionError extends BlockchainError {
  constructor(
    message: string,
    public readonly txHash?: string,
  ) {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

export class AvailabilityError extends BlockchainError {
  constructor(message: string) {
    super(message, 'AVAILABILITY_ERROR');
    this.name = 'AvailabilityError';
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
