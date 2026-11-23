import {
  fundEscrowOnChain,
  disputeBookingOnChain,
  resolveDisputeOnChain,
  getBookingWithEscrow,
} from './bookingContract.js';
import { EscrowError } from './errors.js';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface BookingEscrowParams {
  propertyId: string;
  bookingId: string;
  buyerAddress: string;
  sellerAddress: string;
  amountUsdc: string;
  checkIn: string;
  checkOut: string;
}

export interface CreateEscrowRequest {
  buyer: string;
  seller: string;
  amount: string;
  token: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

/**
 * Correlation context propagated to the provider and to logs. All values are
 * non-secret identifiers; never include tokens, wallet secrets, or payment
 * payloads here.
 */
export interface OperationContext {
  /** Durable, per-booking operation key (idempotency key). */
  operationKey: string;
  /** Booking the operation belongs to. */
  bookingId: string;
  /** Request correlation ID originating from the API layer. */
  requestId?: string;
  /** Logical operation name, e.g. "escrow.create". */
  operation?: string;
}

export interface CreateEscrowOptions {
  context: OperationContext;
}

export interface ReleaseEscrowOptions {
  context: OperationContext;
}

export interface RefundEscrowOptions {
  context: OperationContext;
}

export interface RefundEscrowRequest {
  escrowId: string;
  reason: string;
}

/**
 * Result of reconciling an ambiguous provider outcome after a timeout.
 * `found` is false when the provider has no record of the operation, which
 * means it is safe to retry with the same operation key.
 */
export interface EscrowReconciliationResult {
  found: boolean;
  escrowId?: string;
  contractId?: string;
  status?: EscrowStatus['status'];
  /** True when the provider state shows the operation already took effect. */
  applied: boolean;
}

export interface CreateEscrowResponse {
  escrowId: string;
  contractId: string;
  status: string;
}

export interface FundEscrowRequest {
  escrowId: string;
  amount: string;
  txHash: string;
}

export interface ReleaseEscrowRequest {
  escrowId: string;
  reason: string;
}

export interface EscrowStatus {
  escrowId: string;
  status: 'created' | 'funded' | 'released' | 'cancelled' | 'disputed';
  amount: string;
  token: string;
  buyer: string;
  seller: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class TrustlessWorkClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    context?: OperationContext,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (context) {
      // Idempotency + correlation headers. These are non-secret identifiers.
      headers['Idempotency-Key'] = context.operationKey;
      headers['X-Operation-Key'] = context.operationKey;
      headers['X-Booking-Id'] = context.bookingId;
      if (context.requestId) {
        headers['X-Request-Id'] = context.requestId;
      }
    }
    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let message = `TrustlessWork API error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = (await response.json()) as { message?: string };
        if (errorBody.message) {
          message = errorBody.message;
        }
      } catch {
        // ignore JSON parse errors on error responses
      }
      throw new EscrowError(message, response.status);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Create a new USDC escrow for a booking.
   *
   * @param params - Escrow creation parameters
   * @returns CreateEscrowResponse containing escrowId, contractId, and status
   * @throws EscrowError on non-2xx API responses
   */
  async createEscrow(
    params: CreateEscrowRequest,
    options?: CreateEscrowOptions,
  ): Promise<CreateEscrowResponse> {
    const context = options?.context;
    const body: CreateEscrowRequest = context
      ? {
          ...params,
          metadata: {
            ...(params.metadata ?? {}),
            operationKey: context.operationKey,
            bookingId: context.bookingId,
            ...(context.requestId ? { requestId: context.requestId } : {}),
            ...(context.operation ? { operation: context.operation } : {}),
          },
        }
      : params;
    return this.request<CreateEscrowResponse>('POST', '/escrows', body, context);
  }

  /**
   * Fund an existing escrow after the buyer has sent USDC on-chain.
   *
   * @param escrowId - ID of the escrow to fund
   * @param amount - USDC amount string
   * @param txHash - On-chain transaction hash of the funding transfer
   * @throws EscrowError on non-2xx API responses
   */
  async fundEscrow(escrowId: string, amount: string, txHash: string): Promise<void> {
    const body: FundEscrowRequest = { escrowId, amount, txHash };
    await this.request<void>('POST', `/escrows/${escrowId}/fund`, body);
  }

  /**
   * Release escrowed funds to the seller (property owner).
   *
   * @param escrowId - ID of the escrow to release
   * @param reason - Human-readable reason for the release
   * @throws EscrowError on non-2xx API responses
   */
  async releaseEscrow(
    escrowId: string,
    reason: string,
    options?: ReleaseEscrowOptions,
  ): Promise<void> {
    const body: ReleaseEscrowRequest = { escrowId, reason };
    await this.request<void>(
      'POST',
      `/escrows/${escrowId}/release`,
      body,
      options?.context,
    );
  }

  /**
   * Refund escrowed funds to the buyer (tenant). Idempotent when an operation
   * context is supplied: the provider receives the same operation key on
   * every retry.
   *
   * @param escrowId - ID of the escrow to refund
   * @param reason - Human-readable reason for the refund
   * @param options - Operation/correlation context
   * @throws EscrowError on non-2xx API responses
   */
  async refundEscrow(
    escrowId: string,
    reason: string,
    options?: RefundEscrowOptions,
  ): Promise<void> {
    const body: RefundEscrowRequest = { escrowId, reason };
    await this.request<void>(
      'POST',
      `/escrows/${escrowId}/refund`,
      body,
      options?.context,
    );
  }

  /**
   * Cancel the escrow and return funds to the buyer (tenant).
   *
   * @param escrowId - ID of the escrow to cancel
   * @throws EscrowError on non-2xx API responses
   */
  async cancelEscrow(escrowId: string): Promise<void> {
    await this.request<void>('POST', `/escrows/${escrowId}/cancel`);
  }

  /**
   * Retrieve the current status of an escrow.
   *
   * @param escrowId - ID of the escrow to query
   * @returns EscrowStatus with amounts, participants, and current state
   * @throws EscrowError on non-2xx API responses
   */
  async getEscrowStatus(
    escrowId: string,
    context?: OperationContext,
  ): Promise<EscrowStatus> {
    return this.request<EscrowStatus>('GET', `/escrows/${escrowId}`, undefined, context);
  }

  /**
   * Reconcile an ambiguous outcome (e.g. a timeout after the provider may have
   * accepted the request) by querying provider state. Callers must not retry a
   * create/release/refund until this returns a definitive answer.
   *
   * @param escrowId - Provider escrow reference to look up
   * @param context - Operation/correlation context for tracing
   * @returns Reconciliation result describing whether the operation applied
   * @throws EscrowError on non-2xx API responses
   */
  async reconcileEscrowOperation(
    escrowId: string,
    context?: OperationContext,
  ): Promise<EscrowReconciliationResult> {
    try {
      const status = await this.getEscrowStatus(escrowId, context);
      return {
        found: true,
        escrowId: status.escrowId,
        status: status.status,
        applied: status.status === 'released' || status.status === 'cancelled',
      };
    } catch (err) {
      if (err instanceof EscrowError && err.statusCode === 404) {
        return { found: false, applied: false };
      }
      throw err;
    }
  }

  /**
   * Create an escrow from structured booking parameters, setting a
   * human-readable title and relevant metadata automatically.
   *
   * @param params - Booking-specific parameters
   * @returns CreateEscrowResponse containing escrowId, contractId, and status
   * @throws EscrowError on non-2xx API responses
   */
  async createBookingEscrow(
    params: BookingEscrowParams,
    options?: CreateEscrowOptions,
  ): Promise<CreateEscrowResponse> {
    return this.createEscrow(
      {
        buyer: params.buyerAddress,
        seller: params.sellerAddress,
        amount: params.amountUsdc,
        token: 'USDC',
        title: `Booking ${params.bookingId} — Property ${params.propertyId}`,
        description: `Rental escrow for check-in ${params.checkIn} to check-out ${params.checkOut}`,
        metadata: {
          bookingId: params.bookingId,
          propertyId: params.propertyId,
          checkIn: params.checkIn,
          checkOut: params.checkOut,
        },
      },
      options,
    );
  }

  // ─── Soroban Escrow Integration ──────────────────────────────────────────────

  /**
   * Fund an on-chain escrow via the Soroban booking contract.
   * Tenants call this to deposit USDC into the contract.
   *
   * @param tenant - Stellar address of the tenant (must authorize).
   * @param bookingId - On-chain u64 booking ID.
   */
  async fundOnChainEscrow(tenant: string, bookingId: bigint): Promise<void> {
    await fundEscrowOnChain(tenant, bookingId);
  }

  /**
   * Dispute a funded booking on-chain. Only the tenant may dispute.
   *
   * @param tenant - Stellar address of the tenant (must authorize).
   * @param bookingId - On-chain u64 booking ID.
   */
  async disputeBookingOnChain(tenant: string, bookingId: bigint): Promise<void> {
    await disputeBookingOnChain(tenant, bookingId);
  }

  /**
   * Resolve a disputed booking on-chain. Admin decides the outcome.
   *
   * @param admin - Stellar address of the admin caller.
   * @param bookingId - On-chain u64 booking ID.
   * @param releaseToOwner - true to release to owner, false to refund tenant.
   */
  async resolveDisputeOnChain(
    admin: string,
    bookingId: bigint,
    releaseToOwner: boolean,
  ): Promise<void> {
    await resolveDisputeOnChain(admin, bookingId, releaseToOwner);
  }

  /**
   * Get the on-chain escrow status for a booking.
   *
   * @param bookingId - On-chain u64 booking ID.
   * @returns Object with status, owner, tenant, and price.
   */
  async getOnChainEscrowStatus(
    bookingId: bigint,
  ): Promise<{
    status: string;
    escrowStatus: string;
    propertyOwner: string;
    tenant: string;
    amount: string;
  }> {
    const booking = await getBookingWithEscrow(bookingId);
    return {
      status: booking.status,
      escrowStatus: booking.escrow_status,
      propertyOwner: booking.property_owner,
      tenant: booking.tenant,
      amount: booking.total_price.toString(),
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const trustlessWorkClient = new TrustlessWorkClient(
  process.env.TRUSTLESS_WORK_API_URL ?? 'https://api.trustlesswork.com',
  process.env.TRUSTLESS_WORK_API_KEY ?? '',
);
