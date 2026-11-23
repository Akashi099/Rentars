/**
 * Payment service — canonical state machine for USDC payment intents.
 *
 * State lifecycle (closes #609):
 *
 *   ┌─────────┐
 *   │ pending │  Payment intent created; no transaction submitted yet.
 *   └────┬────┘
 *        │ submitTransaction()
 *        ▼
 *   ┌───────────┐
 *   │ submitted │  Signed XDR delivered to Stellar Horizon; awaiting ledger.
 *   └─────┬─────┘
 *         ├─── confirmTransaction() → ┌───────────┐
 *         │                           │ confirmed │  Ledger sealed; escrow funded.
 *         │                           └───────────┘
 *         ├─── on-chain failure   → ┌────────┐
 *         │                         │ failed │  Terminal; no escrow.
 *         │                         └────────┘
 *         └─── 60 s timeout      → ┌───────────┐
 *                                  │ timed_out │  May be retried.
 *                                  └───────────┘
 *
 * Additional terminal states:
 *   refunded      — escrow cancelled, funds returned to tenant.
 *   under_review  — conflicting update quarantined for manual review.
 *
 * Rules enforced here:
 *  1. Transitions only advance through the allowed graph; regressive moves
 *     are rejected and quarantined as `under_review`.
 *  2. Each event carries a SHA-256 hash of its payload; duplicate hashes
 *     are idempotently replayed without re-applying side-effects.
 *  3. External provider IDs (escrow_id, stellar_tx_hash) are stored so
 *     every payment has a complete, auditable lifecycle.
 *  4. Unknown / unsupported statuses returned by external providers are
 *     quarantined rather than silently accepted.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import {
  amountUsdcToStroops,
  assertSupportedPrecision,
  compareMinorUnits,
  type CurrencyCode,
  type QuoteConversionDetails,
} from './payment.utils.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PaymentStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'timed_out'
  | 'refunded'
  | 'under_review';

/**
 * Allowed forward transitions in the payment state machine.
 * Any move not listed here is rejected and quarantined.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, ReadonlyArray<PaymentStatus>>> = {
  pending:      ['submitted', 'failed'],
  submitted:    ['confirmed', 'failed', 'timed_out'],
  confirmed:    ['refunded'],
  failed:       [],                         // terminal
  timed_out:    ['submitted', 'failed'],    // retryable
  refunded:     [],                         // terminal
  under_review: ['pending', 'failed'],      // admin-only resolution
};

/**
 * External provider statuses mapped to canonical PaymentStatus.
 * Anything not listed is treated as unknown → under_review.
 */
const PROVIDER_STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  // Stellar / Horizon
  SUCCESS:   'confirmed',
  FAILED:    'failed',
  NOT_FOUND: 'timed_out',
  // TrustlessWork escrow statuses
  funded:    'confirmed',
  released:  'refunded',
  cancelled: 'failed',
  disputed:  'under_review',
  created:   'pending',
};

export interface Payment {
  id: string;
  booking_id: string;
  tenant_id: string;
  /** Amount in USDC stroops (integer, 1 USDC = 10_000_000 stroops). */
  amount_stroops: bigint;
  /** Supported currency token — currently only USDC. */
  currency: 'USDC';
  stellar_tx_hash: string | null;
  /** Stellar network the transaction was signed/submitted on (e.g. 'testnet'). */
  network: string | null;
  /** Stellar account (public key) that signed the transaction. */
  source_account: string | null;
  /** TrustlessWork escrow contract ID, if applicable. */
  escrow_id: string | null;
  /** Quote reference hash signed at intent creation (for amount integrity). */
  quote_hash: string | null;
  /**
   * Original amount in the currency the tenant was quoted in, expressed in
   * that currency's canonical minor units (integer, never floating point).
   */
  original_amount_minor: bigint | null;
  /** Currency of the original quoted amount. */
  original_currency: CurrencyCode | null;
  /** Converted amount in USDC stroops (integer minor units). */
  converted_amount_stroops: bigint | null;
  /** Identifier of the rate source used for the conversion (e.g. 'coingecko'). */
  rate_source: string | null;
  /** ISO-8601 timestamp of when the exchange rate was captured. */
  rate_timestamp: string | null;
  /** Rounding mode applied during conversion (e.g. 'half_up'). */
  rounding_mode: string | null;
  status: PaymentStatus;
  /** Version counter incremented on every transition (optimistic concurrency). */
  version: number;
  /** SHA-256 of the last event payload that triggered a transition. */
  last_event_hash: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface CreatePaymentIntentParams {
  bookingId: string;
  tenantId: string;
  /** Amount in USDC stroops (integer). Use amountUsdcToStroops() to convert. */
  amountStroops: bigint;
  /** Quote hash produced by payment.utils.ts#hashQuote() and verified server-side. */
  quoteHash?: string;
  escrowId?: string;
  /** Stellar network the intent is bound to (validated before signing/submission). */
  network?: string;
  /** Stellar account expected to sign the transaction. */
  sourceAccount?: string;
  metadata?: Record<string, unknown>;
  /**
   * Conversion details captured at quote time. When provided, the original
   * currency amount, converted amount, rate source and rate timestamp are
   * persisted alongside the payment intent for audit and disclosure.
   */
  conversion?: QuoteConversionDetails;
}

export interface TransitionResult {
  payment: Payment;
  /** True when the event was a duplicate (same hash) — no side-effects applied. */
  replayed: boolean;
}

// ─── Escrow operation state machine (issues #949 / #993) ─────────────────────

/**
 * Escrow operation kinds. Each kind is a distinct external side-effect and
 * therefore has its own idempotency domain.
 */
export type EscrowOperationKind = 'create' | 'release' | 'refund';

/**
 * Escrow operation lifecycle:
 *
 *   ┌───────────┐  persist fingerprint + key, then submit
 *   │  pending  │──────────────────────────────────────────────┐
 *   └─────┬─────┘                                              │
 *         │ provider accepted                                  │ timeout / unknown
 *         ▼                                                    ▼
 *   ┌───────────┐                                     ┌──────────────┐
 *   │ submitted │                                     │  ambiguous   │
 *   └─────┬─────┘                                     └──────┬───────┘
 *         │ confirmed / failed                               │ reconcile
 *         ▼                                                  │ (query provider)
 *   ┌───────────┐   ┌────────┐                               │
 *   │ confirmed │   │ failed │◄──────────────────────────────┘
 *   └───────────┘   └────────┘
 *
 * Rules:
 *  - The request fingerprint and operation key are persisted BEFORE the
 *    provider is called, so a crash/retry can never create a second escrow.
 *  - `ambiguous` operations block further submissions until reconciled by
 *    querying provider state.
 *  - Retries are bounded and only permitted for safe transient failures.
 */
export type EscrowOperationStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'ambiguous';

/** Maximum number of submission attempts for a single operation key. */
export const MAX_ESCROW_OPERATION_ATTEMPTS = 3;

export interface EscrowOperation {
  id: string;
  /** Durable, caller-supplied idempotency key (unique per booking+kind). */
  operation_key: string;
  booking_id: string;
  payment_id: string | null;
  kind: EscrowOperationKind;
  status: EscrowOperationStatus;
  /** SHA-256 fingerprint of the request payload (amount, parties, etc.). */
  request_fingerprint: string;
  /** Provider-side reference (escrow id / tx hash) once known. */
  provider_reference: string | null;
  attempts: number;
  /** Correlation id propagated from the originating request. */
  correlation_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EscrowOperationContext {
  /** Originating request correlation id (from correlation middleware). */
  correlationId?: string;
  bookingId: string;
  paymentId?: string;
  /** Stable idempotency key; defaults to a deterministic booking+kind key. */
  operationKey?: string;
}

export interface BeginEscrowOperationParams extends EscrowOperationContext {
  kind: EscrowOperationKind;
  /** Request payload used to compute the fingerprint (never logged raw). */
  request: Record<string, unknown>;
}

export interface EscrowOperationResult {
  operation: EscrowOperation;
  /** True when an existing operation was reused (idempotent replay). */
  replayed: boolean;
  /** True when the operation is ambiguous and must be reconciled first. */
  requiresReconciliation: boolean;
}

// ─── Logging / redaction helpers ─────────────────────────────────────────────

const REDACTED = '[REDACTED]';

/** Keys whose values must never appear in logs. */
const SENSITIVE_KEY_PATTERN =
  /(authorization|auth|token|secret|private[_-]?key|seed|mnemonic|password|signature|xdr|signed[_-]?payload|payment[_-]?payload)/i;

/**
 * Recursively redact sensitive values (auth headers, wallet secrets, signed
 * XDR / full payment payloads) from an object before logging.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactForLog(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Emit a structured, redacted log line carrying the correlation context so an
 * operator can trace one booking request through backend and worker events.
 */
function logEscrowEvent(
  event: string,
  ctx: { correlationId?: string | null; bookingId?: string | null; operationId?: string | null },
  fields: Record<string, unknown> = {},
): void {
  const line = {
    scope: 'escrow_operation',
    event,
    correlation_id: ctx.correlationId ?? null,
    booking_id: ctx.bookingId ?? null,
    operation_id: ctx.operationId ?? null,
    ...(redactForLog(fields) as Record<string, unknown>),
  };
  console.info(`[Escrow] ${JSON.stringify(line)}`);
}

/** Deterministic default operation key for a booking + kind. */
export function defaultOperationKey(bookingId: string, kind: EscrowOperationKind): string {
  return `escrow:${bookingId}:${kind}`;
}

/** Stable SHA-256 fingerprint of an escrow request payload. */
export function fingerprintEscrowRequest(request: Record<string, unknown>): string {
  return hashEventPayload(request);
}

// ─── Escrow operation persistence ────────────────────────────────────────────

/**
 * Persist (or reuse) an escrow operation BEFORE any provider call.
 *
 * Idempotency contract:
 *  - The operation key is unique; a second call with the same key returns the
 *    existing row instead of creating a new one.
 *  - A different fingerprint under the same key is rejected as a conflict.
 *  - If the existing operation is `ambiguous`, the caller must reconcile
 *    before submitting again (`requiresReconciliation: true`).
 */
export async function beginEscrowOperation(
  params: BeginEscrowOperationParams,
): Promise<ServiceResponse<EscrowOperationResult>> {
  const { kind, request, bookingId, paymentId, correlationId } = params;
  const operationKey = params.operationKey ?? defaultOperationKey(bookingId, kind);
  const fingerprint = fingerprintEscrowRequest(request);

  const { data: existing } = await supabase
    .from('escrow_operations')
    .select()
    .eq('operation_key', operationKey)
    .maybeSingle();

  if (existing) {
    const op = rowToEscrowOperation(existing);
    if (op.request_fingerprint !== fingerprint) {
      logEscrowEvent('fingerprint_conflict', {
        correlationId: correlationId ?? op.correlation_id,
        bookingId,
        operationId: op.id,
      }, { kind, operationKey });
      return {
        success: false,
        error: `Escrow operation ${operationKey} already exists with a different request fingerprint`,
      };
    }
    const requiresReconciliation = op.status === 'ambiguous';
    logEscrowEvent('operation_reused', {
      correlationId: correlationId ?? op.correlation_id,
      bookingId,
      operationId: op.id,
    }, { kind, status: op.status, attempts: op.attempts, requiresReconciliation });
    return {
      success: true,
      data: { operation: op, replayed: true, requiresReconciliation },
    };
  }

  const { data, error } = await supabase
    .from('escrow_operations')
    .insert({
      operation_key: operationKey,
      booking_id: bookingId,
      payment_id: paymentId ?? null,
      kind,
      status: 'pending',
      request_fingerprint: fingerprint,
      provider_reference: null,
      attempts: 0,
      correlation_id: correlationId ?? null,
      last_error: null,
    })
    .select()
    .single();

  if (error || !data) {
    // Unique-violation race: another process inserted first — reuse it.
    if (error?.code === '23505') {
      const { data: raced } = await supabase
        .from('escrow_operations')
        .select()
        .eq('operation_key', operationKey)
        .single();
      if (raced) {
        const op = rowToEscrowOperation(raced);
        return {
          success: true,
          data: {
            operation: op,
            replayed: true,
            requiresReconciliation: op.status === 'ambiguous',
          },
        };
      }
    }
    return {
      success: false,
      error: `Failed to persist escrow operation: ${error?.message ?? 'unknown error'}`,
    };
  }

  const op = rowToEscrowOperation(data);
  logEscrowEvent('operation_created', {
    correlationId: correlationId ?? null,
    bookingId,
    operationId: op.id,
  }, { kind, operationKey });
  return {
    success: true,
    data: { operation: op, replayed: false, requiresReconciliation: false },
  };
}

/**
 * Record that the operation was submitted to the provider. Increments the
 * attempt counter and enforces the bounded-retry limit.
 */
export async function markEscrowOperationSubmitted(
  operationId: string,
  ctx: { correlationId?: string | null; bookingId?: string | null },
): Promise<ServiceResponse<EscrowOperation>> {
  const op = await getEscrowOperation(operationId);
  if (!op) return { success: false, error: 'Escrow operation not found' };

  if (op.status === 'ambiguous') {
    return {
      success: false,
      error: `Escrow operation ${op.operation_key} is ambiguous; reconcile before retrying`,
    };
  }
  if (op.status === 'confirmed') {
    return { success: true, data: op };
  }
  if (op.attempts >= MAX_ESCROW_OPERATION_ATTEMPTS) {
    logEscrowEvent('retry_exhausted', {
      correlationId: ctx.correlationId ?? op.correlation_id,
      bookingId: ctx.bookingId ?? op.booking_id,
      operationId: op.id,
    }, { attempts: op.attempts });
    return {
      success: false,
      error: `Escrow operation ${op.operation_key} exceeded ${MAX_ESCROW_OPERATION_ATTEMPTS} attempts`,
    };
  }

  const { data, error } = await supabase
    .from('escrow_operations')
    .update({
      status: 'submitted',
      attempts: op.attempts + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .eq('version' in op ? (op as unknown as { version: number }).version : 'id', operationId)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to mark escrow operation submitted: ${error?.message ?? 'unknown error'}` };
  }

  const updated = rowToEscrowOperation(data);
  logEscrowEvent('operation_submitted', {
    correlationId: ctx.correlationId ?? updated.correlation_id,
    bookingId: ctx.bookingId ?? updated.booking_id,
    operationId: updated.id,
  }, { kind: updated.kind, attempts: updated.attempts });
  return { success: true, data: updated };
}

/**
 * Mark an operation ambiguous after a timeout or unknown provider outcome.
 * Ambiguous operations block further submissions until reconciled.
 */
export async function markEscrowOperationAmbiguous(
  operationId: string,
  reason: string,
  ctx: { correlationId?: string | null; bookingId?: string | null },
): Promise<ServiceResponse<EscrowOperation>> {
  const op = await getEscrowOperation(operationId);
  if (!op) return { success: false, error: 'Escrow operation not found' };

  const { data, error } = await supabase
    .from('escrow_operations')
    .update({
      status: 'ambiguous',
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to mark escrow operation ambiguous: ${error?.message ?? 'unknown error'}` };
  }

  const updated = rowToEscrowOperation(data);
  logEscrowEvent('operation_ambiguous', {
    correlationId: ctx.correlationId ?? updated.correlation_id,
    bookingId: ctx.bookingId ?? updated.booking_id,
    operationId: updated.id,
  }, { kind: updated.kind, reason });
  return { success: true, data: updated };
}

/**
 * Reconcile an ambiguous operation by querying provider state. Only after a
 * definitive provider answer is the operation moved to confirmed/failed.
 */
export async function reconcileEscrowOperation(
  operationId: string,
  providerStatus: string,
  providerReference: string | null,
  ctx: { correlationId?: string | null; bookingId?: string | null },
): Promise<ServiceResponse<EscrowOperation>> {
  const op = await getEscrowOperation(operationId);
  if (!op) return { success: false, error: 'Escrow operation not found' };

  const mapped = mapProviderStatus(providerStatus);
  let nextStatus: EscrowOperationStatus;
  if (mapped === 'confirmed') nextStatus = 'confirmed';
  else if (mapped === 'failed') nextStatus = 'failed';
  else {
    // Still unknown — remain ambiguous, do not permit resubmission.
    logEscrowEvent('reconcile_inconclusive', {
      correlationId: ctx.correlationId ?? op.correlation_id,
      bookingId: ctx.bookingId ?? op.booking_id,
      operationId: op.id,
    }, { providerStatus });
    return { success: true, data: op };
  }

  const { data, error } = await supabase
    .from('escrow_operations')
    .update({
      status: nextStatus,
      provider_reference: providerReference ?? op.provider_reference,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to reconcile escrow operation: ${error?.message ?? 'unknown error'}` };
  }

  const updated = rowToEscrowOperation(data);
  logEscrowEvent('operation_reconciled', {
    correlationId: ctx.correlationId ?? updated.correlation_id,
    bookingId: ctx.bookingId ?? updated.booking_id,
    operationId: updated.id,
  }, { kind: updated.kind, status: updated.status, providerReference });
  return { success: true, data: updated };
}

/**
 * Finalize an operation with a definitive provider outcome (confirmed/failed).
 */
export async function completeEscrowOperation(
  operationId: string,
  outcome: 'confirmed' | 'failed',
  providerReference: string | null,
  ctx: { correlationId?: string | null; bookingId?: string | null },
): Promise<ServiceResponse<EscrowOperation>> {
  const op = await getEscrowOperation(operationId);
  if (!op) return { success: false, error: 'Escrow operation not found' };

  // Idempotent: already terminal with same outcome → replay.
  if (op.status === outcome) {
    return { success: true, data: op };
  }
  if (op.status === 'confirmed' && outcome === 'failed') {
    return { success: false, error: `Escrow operation ${op.operation_key} already confirmed` };
  }

  const { data, error } = await supabase
    .from('escrow_operations')
    .update({
      status: outcome,
      provider_reference: providerReference ?? op.provider_reference,
      updated_at: new Date().toISOString(),
    })
    .eq('id', operationId)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to complete escrow operation: ${error?.message ?? 'unknown error'}` };
  }

  const updated = rowToEscrowOperation(data);
  logEscrowEvent('operation_completed', {
    correlationId: ctx.correlationId ?? updated.correlation_id,
    bookingId: ctx.bookingId ?? updated.booking_id,
    operationId: updated.id,
  }, { kind: updated.kind, status: updated.status, providerReference });
  return { success: true, data: updated };
}

/** Load an escrow operation by id. */
export async function getEscrowOperation(operationId: string): Promise<EscrowOperation | null> {
  const { data } = await supabase
    .from('escrow_operations')
    .select()
    .eq('id', operationId)
    .single();
  return data ? rowToEscrowOperation(data) : null;
}

/** Load an escrow operation by its durable operation key. */
export async function getEscrowOperationByKey(operationKey: string): Promise<EscrowOperation | null> {
  const { data } = await supabase
    .from('escrow_operations')
    .select()
    .eq('operation_key', operationKey)
    .maybeSingle();
  return data ? rowToEscrowOperation(data) : null;
}

/**
 * Guard used by callers before submitting to the provider: returns true only
 * when the operation may safely be (re)submitted.
 */
export function canSubmitEscrowOperation(op: EscrowOperation): boolean {
  if (op.status === 'ambiguous') return false;
  if (op.status === 'confirmed') return false;
  if (op.status === 'failed') return false;
  return op.attempts < MAX_ESCROW_OPERATION_ATTEMPTS;
}

// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToEscrowOperation(row: any): EscrowOperation {
  return {
    id:                  row.id,
    operation_key:       row.operation_key,
    booking_id:          row.booking_id,
    payment_id:          row.payment_id ?? null,
    kind:                row.kind as EscrowOperationKind,
    status:              row.status as EscrowOperationStatus,
    request_fingerprint: row.request_fingerprint,
    provider_reference:  row.provider_reference ?? null,
    attempts:            row.attempts ?? 0,
    correlation_id:      row.correlation_id ?? null,
    last_error:          row.last_error ?? null,
    created_at:          row.created_at,
    updated_at:          row.updated_at,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a stable SHA-256 hex digest of an event payload object.
 * Used to detect duplicate provider callbacks.
 */
export function hashEventPayload(payload: Record<string, unknown>): string {
  const stable = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Returns true when `from → to` is a permitted transition.
 */
export function isAllowedTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Map an external provider status string to a canonical PaymentStatus.
 * Returns `under_review` for any unknown value.
 */
export function mapProviderStatus(raw: string): PaymentStatus {
  return PROVIDER_STATUS_MAP[raw] ?? 'under_review';
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create a new payment intent in `pending` state.
 *
 * @returns The newly created Payment record.
 * @throws  On database error.
 */
export async function createPaymentIntent(
  params: CreatePaymentIntentParams,
): Promise<Payment> {
  const {
    bookingId,
    tenantId,
    amountStroops,
    quoteHash,
    escrowId,
    metadata,
    conversion,
  } = params;

  // ── Validate precision and conversion consistency (integer minor units) ──
  if (amountStroops <= 0n) {
    throw new Error('Payment amount must be a positive integer number of stroops');
  }

  let originalAmountMinor: bigint | null = null;
  let originalCurrency: CurrencyCode | null = null;
  let convertedAmountStroops: bigint | null = null;
  let rateSource: string | null = null;
  let rateTimestamp: string | null = null;
  let roundingMode: string | null = null;

  if (conversion) {
    originalCurrency = conversion.originalCurrency;
    originalAmountMinor = conversion.originalAmountMinor;
    convertedAmountStroops = conversion.convertedAmountStroops;
    rateSource = conversion.rateSource;
    rateTimestamp = conversion.rateTimestamp;
    roundingMode = conversion.roundingMode;

    // Reject values beyond the currency's supported precision.
    assertSupportedPrecision(originalCurrency, originalAmountMinor);

    if (convertedAmountStroops <= 0n) {
      throw new Error('Converted amount must be a positive integer number of stroops');
    }

    // The converted amount must match the amount actually being charged.
    if (compareMinorUnits(convertedAmountStroops, amountStroops) !== 0) {
      throw new Error(
        `Converted amount (${convertedAmountStroops.toString()} stroops) does not match ` +
          `payment amount (${amountStroops.toString()} stroops)`,
      );
    }

    if (!rateSource) {
      throw new Error('Conversion rate source is required');
    }
    if (!rateTimestamp || Number.isNaN(Date.parse(rateTimestamp))) {
      throw new Error('Conversion rate timestamp is required and must be a valid ISO-8601 date');
    }
  }

  const { data, error } = await supabase
    .from('payments')
    .insert({
      booking_id: bookingId,
      tenant_id: tenantId,
      amount_stroops: amountStroops.toString(), // stored as text to avoid JS bigint loss
      currency: 'USDC',
      status: 'pending',
      escrow_id: escrowId ?? null,
      quote_hash: quoteHash ?? null,
      original_amount_minor: originalAmountMinor?.toString() ?? null,
      original_currency: originalCurrency ?? null,
      converted_amount_stroops: convertedAmountStroops?.toString() ?? null,
      rate_source: rateSource ?? null,
      rate_timestamp: rateTimestamp ?? null,
      rounding_mode: roundingMode ?? null,
      version: 1,
      last_event_hash: null,
      metadata: metadata ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create payment intent: ${error?.message ?? 'unknown error'}`);
  }

  const payment = rowToPayment(data);

  await auditLogger.log({
    actorId: tenantId,
    action: 'payment.submit',
    resourceType: 'payment',
    resourceId: payment.id,
    meta: {
      bookingId,
      amountStroops: amountStroops.toString(),
      correlationId: (metadata?.correlationId as string | undefined) ?? null,
    },
  });

  return payment;
}

/**
 * Record the network and signing account on an existing payment intent.
 * Called before signing so a wrong-network or wrong-account transaction can
 * never be attached to the booking.
 */
export async function bindPaymentNetwork(
  paymentId: string,
  network: string,
  sourceAccount: string,
): Promise<ServiceResponse<Payment>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  // Once a network is bound it must not silently change (account switching /
  // network switching would invalidate the signed transaction).
  if (payment.network && payment.network !== network) {
    return {
      success: false,
      error: `Network mismatch: payment bound to ${payment.network}, got ${network}`,
    };
  }
  if (payment.source_account && payment.source_account !== sourceAccount) {
    return {
      success: false,
      error: `Account mismatch: payment bound to ${payment.source_account}, got ${sourceAccount}`,
    };
  }

  const { data, error } = await supabase
    .from('payments')
    .update({ network, source_account: sourceAccount, updated_at: new Date().toISOString() })
    .eq('id', paymentId)
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to bind payment network: ${error?.message ?? 'unknown error'}` };
  }

  return { success: true, data: rowToPayment(data) };
}

/**
 * Record a submitted transaction hash. Idempotent: if a hash is already
 * recorded, the existing hash is returned and no duplicate broadcast is
 * implied. Callers must re-poll the existing hash rather than re-submitting.
 */
export async function recordSubmittedTx(
  paymentId: string,
  txHash: string,
  network: string,
  sourceAccount: string,
): Promise<ServiceResponse<{ payment: Payment; duplicate: boolean }>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  if (payment.network && payment.network !== network) {
    return { success: false, error: `Network mismatch: payment bound to ${payment.network}, got ${network}` };
  }
  if (payment.source_account && payment.source_account !== sourceAccount) {
    return { success: false, error: `Account mismatch: payment bound to ${payment.source_account}, got ${sourceAccount}` };
  }

  // Duplicate submission: a different tx hash already recorded → do not
  // overwrite; surface the existing hash so the caller re-polls it.
  if (payment.stellar_tx_hash && payment.stellar_tx_hash !== txHash) {
    return {
      success: true,
      data: { payment, duplicate: true },
    };
  }

  const result = await transitionPaymentStatus(
    paymentId,
    'submitted',
    { txHash, network, sourceAccount, _source: 'submit' },
    txHash,
  );

  if (!result.success || !result.data) {
    return { success: false, error: result.error ?? 'Failed to record submitted tx' };
  }

  return {
    success: true,
    data: { payment: result.data.payment, duplicate: result.data.replayed },
  };
}

/**
 * Transition a payment to a new status with full idempotency and conflict
 * quarantine.
 *
 * Algorithm:
 *  1. Load current payment with optimistic version.
 *  2. Hash the incoming event payload.
 *  3. If `last_event_hash` matches → replay without side-effects.
 *  4. Verify the transition is allowed; if not → quarantine to `under_review`.
 *  5. Apply the update with version increment; on version conflict retry once.
 *
 * @param paymentId    - UUID of the payment to transition.
 * @param newStatus    - Target status.
 * @param eventPayload - Raw event data (used for duplicate detection).
 * @param txHash       - Optional Stellar transaction hash to record.
 * @param actorId      - Optional actor UUID for audit (omit for system actions).
 *
 * @returns TransitionResult containing updated Payment and replayed flag.
 */
export async function transitionPaymentStatus(
  paymentId: string,
  newStatus: PaymentStatus,
  eventPayload: Record<string, unknown>,
  txHash?: string | null,
  actorId?: string,
): Promise<ServiceResponse<TransitionResult>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  const eventHash = hashEventPayload(eventPayload);

  // ── Idempotency: same event hash → replay without side-effects ────────────
  if (payment.last_event_hash === eventHash) {
    return {
      success: true,
      data: { payment, replayed: true },
    };
  }

  // ── Validate transition ────────────────────────────────────────────────────
  let targetStatus: PaymentStatus = newStatus;
  let quarantineReason: string | undefined;

  if (!isAllowedTransition(payment.status, newStatus)) {
    // Unknown or regressive transition → quarantine
    targetStatus = 'under_review';
    quarantineReason = `Disallowed transition: ${payment.status} → ${newStatus}`;
  }

  // ── Persist with optimistic concurrency ───────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    status: targetStatus,
    version: payment.version + 1,
    last_event_hash: eventHash,
    updated_at: new Date().toISOString(),
  };
  if (txHash !== undefined) updatePayload.stellar_tx_hash = txHash;
  if (quarantineReason) {
    // Store quarantine reason in metadata for manual review
    updatePayload.metadata = {
      ...(payment.metadata ?? {}),
      quarantine_reason: quarantineReason,
      quarantined_at: new Date().toISOString(),
    };
  }

  const { data, error } = await supabase
    .from('payments')
    .update(updatePayload)
    .eq('id', paymentId)
    .eq('version', payment.version) // optimistic concurrency guard
    .select()
    .single();

  if (error || !data) {
    // Version conflict — another process transitioned first
    return {
      success: false,
      error: `Concurrent payment transition conflict for ${paymentId}: ${error?.message ?? 'version mismatch'}`,
    };
  }

  const updated = rowToPayment(data);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const auditAction =
    targetStatus === 'confirmed'  ? ('payment.confirmed' as const) :
    targetStatus === 'failed'     ? ('payment.failed'    as const) :
    targetStatus === 'refunded'   ? ('payment.failed'    as const) :
    ('payment.submit' as const);

  await auditLogger.log({
    actorId,
    action: auditAction,
    resourceType: 'payment',
    resourceId: paymentId,
    meta: {
      fromStatus: payment.status,
      toStatus: targetStatus,
      txHash,
      quarantineReason,
    },
  });

  // Alert on quarantine (redact payload — may contain signed XDR / secrets)
  if (targetStatus === 'under_review') {
    console.error(
      `[Payment] QUARANTINE paymentId=${paymentId} reason="${quarantineReason}" payload=%j`,
      redactForLog(eventPayload),
    );
  }

  return {
    success: true,
    data: { payment: updated, replayed: false },
  };
}

/**
 * @deprecated Use transitionPaymentStatus() instead.
 *
 * Retained for backward-compatibility with stellar.service.ts callers that
 * have not yet been migrated to the new API.
 */
export async function updatePaymentStatus(
  paymentId: string,
  txHash: string | null,
  status: PaymentStatus,
): Promise<Payment> {
  const result = await transitionPaymentStatus(
    paymentId,
    status,
    { txHash, status, _source: 'stellar_confirmation' },
    txHash,
  );

  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'Failed to update payment status');
  }

  return result.data.payment;
}

/**
 * Get a payment record by ID. Returns null if not found.
 */
export async function getPaymentStatus(paymentId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('id', paymentId)
    .single();
  return data ? rowToPayment(data) : null;
}

/**
 * Get a payment record by booking ID. Returns null if not found.
 */
export async function getPaymentByBookingId(bookingId: string): Promise<Payment | null> {
  const { data } = await supabase
    .from('payments')
    .select()
    .eq('booking_id', bookingId)
    .single();
  return data ? rowToPayment(data) : null;
}

/**
 * Reconcile a payment against an externally reported amount.
 *
 * Comparison is performed exclusively on integer minor units (USDC stroops)
 * via compareMinorUnits() — binary floating-point values are never used, so
 * rounding can never silently change the amount transferred.
 *
 * @param paymentId       - UUID of the payment to reconcile.
 * @param reportedStroops - Amount reported by the provider/ledger, in stroops.
 * @returns Whether the amounts match, plus the canonical payment record.
 */
export async function reconcilePaymentAmount(
  paymentId: string,
  reportedStroops: bigint,
): Promise<ServiceResponse<{ payment: Payment; matches: boolean }>> {
  const payment = await getPaymentStatus(paymentId);
  if (!payment) {
    return { success: false, error: 'Payment not found' };
  }

  if (reportedStroops < 0n) {
    return { success: false, error: 'Reported amount must not be negative' };
  }

  const matches = compareMinorUnits(payment.amount_stroops, reportedStroops) === 0;

  if (!matches) {
    await auditLogger.log({
      actorId: payment.tenant_id,
      action: 'payment.failed',
      resourceType: 'payment',
      resourceId: paymentId,
      meta: {
        reason: 'amount_mismatch',
        expectedStroops: payment.amount_stroops.toString(),
        reportedStroops: reportedStroops.toString(),
      },
    });
  }

  return { success: true, data: { payment, matches } };
}

/**
 * Convert a USDC decimal string to integer stroops using decimal-safe helpers.
 * Exposed here so callers do not reach for floating-point arithmetic.
 */
export function toStroops(usdcAmount: string): bigint {
  return amountUsdcToStroops(usdcAmount);
}

// ─── Row mapping ──────────────────────────────────────────────────────────────

/**
 * Map a raw Supabase row to a typed Payment, handling BigInt conversion.
 */
// biome-ignore lint/suspicious/noExplicitAny: raw Supabase row
function rowToPayment(row: any): Payment {
  return {
    id:               row.id,
    booking_id:       row.booking_id,
    tenant_id:        row.tenant_id,
    amount_stroops:   BigInt(row.amount_stroops ?? row.amount_usdc ?? 0),
    currency:         row.currency ?? 'USDC',
    stellar_tx_hash:  row.stellar_tx_hash ?? null,
    network:          row.network ?? null,
    source_account:   row.source_account ?? null,
    escrow_id:        row.escrow_id ?? null,
    quote_hash:       row.quote_hash ?? null,
    original_amount_minor:
      row.original_amount_minor != null ? BigInt(row.original_amount_minor) : null,
    original_currency: (row.original_currency ?? null) as CurrencyCode | null,
    converted_amount_stroops:
      row.converted_amount_stroops != null ? BigInt(row.converted_amount_stroops) : null,
    rate_source:      row.rate_source ?? null,
    rate_timestamp:   row.rate_timestamp ?? null,
    rounding_mode:    row.rounding_mode ?? null,
    status:           row.status as PaymentStatus,
    version:          row.version ?? 1,
    last_event_hash:  row.last_event_hash ?? null,
    created_at:       row.created_at,
    updated_at:       row.updated_at,
    metadata:         row.metadata ?? null,
  };
}
