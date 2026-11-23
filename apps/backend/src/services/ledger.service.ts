/**
 * Ledger service — append-only credit/debit entries for host earnings (#770).
 *
 * Architecture:
 *  - Every financial event produces one immutable ledger entry (credit or debit).
 *  - Balances are derived by summing entries; no mutable summary rows.
 *  - Each entry carries a unique source_ref that prevents duplicates (upsert
 *    on conflict is a no-op, so duplicate callbacks never create double entries).
 *  - Corrections create new `adjustment` entries rather than editing history.
 *  - Period and currency filters allow time-boxed and multi-currency queries.
 *
 * Entry types:
 *   booking_payment  — tenant payment credited to the host (minus platform fee)
 *   escrow_release   — on-chain escrow released to the host
 *   refund_debit     — refund subtracted from host balance
 *   platform_fee     — platform fee deducted from gross amount
 *   adjustment       — manual correction posted by ops (always has admin_note)
 *
 * source_ref format:
 *   <entry_type>:<related_entity_id>        e.g. "booking_payment:uuid"
 *   "adjustment:<admin_uuid>:<iso_timestamp>"  for manual corrections
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_FEE_RATE = 0.05; // 5%

// ─── Types ────────────────────────────────────────────────────────────────────

export type LedgerEntryType =
  | 'booking_payment'
  | 'escrow_release'
  | 'refund_debit'
  | 'platform_fee'
  | 'adjustment';

export type LedgerDirection = 'credit' | 'debit';

/** Supported currency tokens. */
export type LedgerCurrency = 'USDC';

export interface LedgerEntry {
  id: string;
  host_id: string;
  booking_id: string | null;
  entry_type: LedgerEntryType;
  direction: LedgerDirection;
  /** Amount in currency units (always positive). */
  amount: number;
  currency: LedgerCurrency;
  /**
   * Unique reference that prevents duplicate entries.
   * Format: `<entry_type>:<entity_id>` — the DB has a UNIQUE constraint on
   * (host_id, source_ref) so an upsert on conflict is a safe no-op.
   */
  source_ref: string;
  /** Free-text note required for `adjustment` entries. */
  admin_note: string | null;
  created_at: string;
}

export interface LedgerBalance {
  total_credits: number;
  total_debits: number;
  net: number;
  currency: LedgerCurrency;
  entry_count: number;
}

export interface LedgerReconciliationReport {
  host_id: string;
  from: string;
  to: string;
  currency: LedgerCurrency;
  balance: LedgerBalance;
  entries: LedgerEntry[];
  /** True when ledger net matches the sum of settled booking amounts. */
  reconciled: boolean;
  /** Difference between ledger net and settled bookings (0 when reconciled). */
  drift: number;
}

export interface WriteEntryParams {
  hostId: string;
  bookingId?: string | null;
  entryType: LedgerEntryType;
  direction: LedgerDirection;
  amount: number;
  currency?: LedgerCurrency;
  sourceRef: string;
  adminNote?: string;
}

export interface PeriodFilter {
  from: string;
  to: string;
  currency?: LedgerCurrency;
}

// ─── Payment timeline ─────────────────────────────────────────────────────────

/**
 * Canonical payment timeline stages, ordered from earliest to latest.
 *
 * `provider_processing` reflects a provider-side acknowledgement and is NOT a
 * final success — only `confirmed` (ledger confirmation) and `settled` are
 * terminal success states. `refunded` and `failed` are terminal as well.
 */
export type PaymentTimelineStage =
  | 'quote'
  | 'submitted'
  | 'provider_processing'
  | 'confirmed'
  | 'settled'
  | 'refunded'
  | 'failed';

/** Role of the participant requesting the timeline. */
export type PaymentTimelineRole = 'tenant' | 'host';

export interface PaymentTimelineEvent {
  stage: PaymentTimelineStage;
  /** Human-readable, consistent label for the stage. */
  label: string;
  /** ISO timestamp of when the stage was reached. */
  timestamp: string;
  /** True when this event represents a final state (no further updates). */
  terminal: boolean;
  /** True when this event is a success state (confirmed/settled). */
  success: boolean;
  /**
   * Amount in integer minor units (stroops for USDC, 7 decimals).
   * Only present when the requesting role may see amounts.
   */
  amount_minor?: number;
  /** Currency token, present alongside amount_minor. */
  currency?: LedgerCurrency;
  /**
   * Provider-side reference (e.g. tx hash). Visible to both parties but never
   * contains internal ledger identifiers.
   */
  provider_ref?: string | null;
  /** Safe, role-appropriate next-step hint for pending/failed states. */
  next_step?: string | null;
}

export interface PaymentTimeline {
  booking_id: string;
  role: PaymentTimelineRole;
  /** Ordered events, earliest first. */
  events: PaymentTimelineEvent[];
  /** Current (latest) stage. */
  current_stage: PaymentTimelineStage;
  /** True when the timeline has reached a terminal state — clients stop polling. */
  terminal: boolean;
  /** True only when the ledger has confirmed final settlement. */
  settled: boolean;
  /** True when the payment failed or was refunded. */
  failed: boolean;
  /** ISO timestamp of the last update, for polling clients. */
  updated_at: string;
}

const STAGE_LABELS: Record<PaymentTimelineStage, string> = {
  quote:               'Quote',
  submitted:           'Submitted',
  provider_processing: 'Processing with provider',
  confirmed:           'Confirmed',
  settled:             'Settled',
  refunded:            'Refunded',
  failed:              'Failed',
};

const TERMINAL_STAGES: ReadonlySet<PaymentTimelineStage> = new Set<PaymentTimelineStage>([
  'settled',
  'refunded',
  'failed',
]);

const SUCCESS_STAGES: ReadonlySet<PaymentTimelineStage> = new Set<PaymentTimelineStage>([
  'confirmed',
  'settled',
]);

const STAGE_ORDER: Record<PaymentTimelineStage, number> = {
  quote:               0,
  submitted:           1,
  provider_processing: 2,
  confirmed:           3,
  settled:             4,
  refunded:            5,
  failed:              6,
};

/** Convert a decimal currency amount to integer minor units (stroops). */
function toMinorUnits(amount: number): number {
  return Math.round(Number(amount) * 10_000_000);
}

function nextStepFor(stage: PaymentTimelineStage, role: PaymentTimelineRole): string | null {
  switch (stage) {
    case 'quote':
      return role === 'tenant' ? 'Review and submit payment to continue.' : 'Awaiting tenant payment.';
    case 'submitted':
      return 'Payment submitted — awaiting provider acknowledgement.';
    case 'provider_processing':
      return 'Provider is processing the payment. This is not yet a final confirmation.';
    case 'confirmed':
      return 'Payment confirmed on the ledger. Final settlement is pending.';
    case 'failed':
      return role === 'tenant'
        ? 'Payment failed. Retry or contact support.'
        : 'Payment failed. No funds were credited.';
    case 'refunded':
      return role === 'tenant'
        ? 'Refund issued to your account.'
        : 'Refund issued to the tenant; balance adjusted.';
    default:
      return null;
  }
}

/**
 * Build a privacy-safe payment timeline for a booking from the canonical
 * payment ledger.
 *
 * Visibility rules:
 *  - Both roles see stage, label, timestamp, terminal/success flags and the
 *    provider reference.
 *  - Amounts (minor units) and currency are visible to both parties for their
 *    own booking, but internal ledger identifiers and admin notes are never
 *    exposed.
 *  - `next_step` hints are role-appropriate.
 *
 * Amounts are returned in integer minor units. Terminal states are flagged so
 * clients can stop polling.
 */
export async function getPaymentTimeline(
  bookingId: string,
  role: PaymentTimelineRole,
): Promise<ServiceResponse<PaymentTimeline>> {
  if (!bookingId) return { success: false, error: 'bookingId is required' };
  if (role !== 'tenant' && role !== 'host') {
    return { success: false, error: 'role must be tenant or host' };
  }

  // Load the booking to derive quote/submitted timestamps and the host owner.
  const { data: bookingRow, error: bookingError } = await supabase
    .from('bookings')
    .select('id, total_price, currency, status, created_at, updated_at, properties!inner(owner_id)')
    .eq('id', bookingId)
    .maybeSingle();

  if (bookingError) return { success: false, error: bookingError.message };
  if (!bookingRow) return { success: false, error: 'Booking not found' };

  const booking = bookingRow as unknown as {
    id: string;
    total_price: number | string | null;
    currency: LedgerCurrency | null;
    status: string | null;
    created_at: string;
    updated_at: string;
    properties: { owner_id: string } | { owner_id: string }[];
  };

  const ownerId = Array.isArray(booking.properties)
    ? booking.properties[0]?.owner_id
    : booking.properties?.owner_id;

  const currency: LedgerCurrency = booking.currency ?? 'USDC';
  const grossAmount = Number(booking.total_price ?? 0);

  // Load canonical ledger entries for this booking (host-scoped).
  const { data: ledgerRows, error: ledgerError } = await supabase
    .from('earnings_ledger_entries')
    .select('entry_type, direction, amount, currency, source_ref, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });

  if (ledgerError) return { success: false, error: ledgerError.message };

  const entries = (ledgerRows ?? []) as Array<{
    entry_type: LedgerEntryType;
    direction: LedgerDirection;
    amount: number;
    currency: LedgerCurrency;
    source_ref: string;
    created_at: string;
  }>;

  // Load provider-side payment status (never exposes internal ledger ids).
  const { data: paymentRow, error: paymentError } = await supabase
    .from('payments')
    .select('status, tx_hash, updated_at')
    .eq('booking_id', bookingId)
    .maybeSingle();

  if (paymentError) return { success: false, error: paymentError.message };

  const payment = paymentRow as
    | { status: string | null; tx_hash: string | null; updated_at: string | null }
    | null;

  const events: PaymentTimelineEvent[] = [];

  const pushEvent = (
    stage: PaymentTimelineStage,
    timestamp: string,
    extra: Partial<PaymentTimelineEvent> = {},
  ) => {
    events.push({
      stage,
      label: STAGE_LABELS[stage],
      timestamp,
      terminal: TERMINAL_STAGES.has(stage),
      success: SUCCESS_STAGES.has(stage),
      amount_minor: toMinorUnits(grossAmount),
      currency,
      provider_ref: payment?.tx_hash ?? null,
      next_step: nextStepFor(stage, role),
      ...extra,
    });
  };

  // 1. Quote — booking created.
  pushEvent('quote', booking.created_at);

  // 2. Submitted — payment row exists (provider received the request).
  const paymentStatus = (payment?.status ?? '').toLowerCase();
  const hasPayment = Boolean(payment);
  if (hasPayment) {
    pushEvent('submitted', payment?.updated_at ?? booking.updated_at);
  }

  // 3. Provider processing — provider acknowledged but not final.
  if (paymentStatus === 'processing' || paymentStatus === 'pending' || paymentStatus === 'submitted') {
    pushEvent('provider_processing', payment?.updated_at ?? booking.updated_at);
  }

  // 4. Confirmed — ledger booking_payment credit exists (ledger confirmation).
  const bookingPaymentEntry = entries.find((e) => e.entry_type === 'booking_payment');
  if (bookingPaymentEntry) {
    pushEvent('confirmed', bookingPaymentEntry.created_at);
  }

  // 5. Settled — escrow release recorded (final ledger confirmation).
  const escrowEntry = entries.find((e) => e.entry_type === 'escrow_release');
  if (escrowEntry) {
    pushEvent('settled', escrowEntry.created_at);
  }

  // 6. Refunded — refund debit recorded.
  const refundEntry = entries.find((e) => e.entry_type === 'refund_debit');
  if (refundEntry) {
    pushEvent('refunded', refundEntry.created_at, {
      amount_minor: toMinorUnits(Number(refundEntry.amount)),
    });
  }

  // 7. Failed — provider reported failure and no ledger confirmation exists.
  if (paymentStatus === 'failed' && !bookingPaymentEntry) {
    pushEvent('failed', payment?.updated_at ?? booking.updated_at);
  }

  // Order deterministically by stage order, then timestamp.
  events.sort((a, b) => {
    const byStage = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
    if (byStage !== 0) return byStage;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });

  const currentStage = events.length > 0 ? events[events.length - 1].stage : 'quote';
  const terminal = TERMINAL_STAGES.has(currentStage);
  const settled = currentStage === 'settled';
  const failed = currentStage === 'failed' || currentStage === 'refunded';
  const updatedAt = events.length > 0 ? events[events.length - 1].timestamp : booking.updated_at;

  return {
    success: true,
    data: {
      booking_id: bookingId,
      role,
      events,
      current_stage: currentStage,
      terminal,
      settled,
      failed,
      updated_at: updatedAt,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateDateRange(from: string, to: string): string | null {
  const f = new Date(from);
  const t = new Date(to);
  if (isNaN(f.getTime())) return 'from is not a valid date';
  if (isNaN(t.getTime())) return 'to is not a valid date';
  if (t < f) return 'to must be on or after from';
  return null;
}

// ─── Core write ───────────────────────────────────────────────────────────────

/**
 * Write a single ledger entry atomically.
 *
 * Uses an upsert with `ignoreDuplicates: true` on (host_id, source_ref) so
 * retried or duplicate callbacks are safely ignored without extra round-trips.
 *
 * @returns The newly created entry, or null if it was a duplicate (idempotent).
 */
export async function writeLedgerEntry(
  params: WriteEntryParams,
): Promise<ServiceResponse<LedgerEntry | null>> {
  if (!params.hostId) return { success: false, error: 'hostId is required' };
  if (!params.sourceRef) return { success: false, error: 'sourceRef is required' };
  if (!Number.isFinite(params.amount) || params.amount < 0) {
    return { success: false, error: 'amount must be a non-negative finite number' };
  }
  if (params.entryType === 'adjustment' && !params.adminNote) {
    return { success: false, error: 'adminNote is required for adjustment entries' };
  }

  const row = {
    host_id:    params.hostId,
    booking_id: params.bookingId ?? null,
    entry_type: params.entryType,
    direction:  params.direction,
    amount:     params.amount,
    currency:   params.currency ?? 'USDC',
    source_ref: params.sourceRef,
    admin_note: params.adminNote ?? null,
    created_at: new Date().toISOString(),
  };

  // Upsert: on duplicate (host_id, source_ref) do nothing (idempotent)
  const { data, error } = await supabase
    .from('earnings_ledger_entries')
    .upsert(row, { onConflict: 'host_id,source_ref', ignoreDuplicates: true })
    .select()
    .maybeSingle();

  if (error) {
    return { success: false, error: `Ledger write failed: ${error.message}` };
  }

  // data is null when the upsert was a no-op (duplicate)
  return { success: true, data: data as LedgerEntry | null };
}

// ─── Atomic settlement recording ─────────────────────────────────────────────

/**
 * Record a booking settlement atomically: write a booking_payment credit and
 * the corresponding platform_fee debit in a single call.
 *
 * Idempotent — safe to call multiple times for the same booking.
 *
 * @param hostId     - Host user ID
 * @param bookingId  - UUID of the settled booking
 * @param grossAmount - Booking total_price before platform fee
 */
export async function recordBookingSettlement(
  hostId: string,
  bookingId: string,
  grossAmount: number,
): Promise<ServiceResponse<{ creditEntry: LedgerEntry | null; feeEntry: LedgerEntry | null }>> {
  if (!hostId) return { success: false, error: 'hostId is required' };
  if (!bookingId) return { success: false, error: 'bookingId is required' };
  if (!Number.isFinite(grossAmount) || grossAmount < 0) {
    return { success: false, error: 'grossAmount must be a non-negative finite number' };
  }

  const { error } = await supabase.rpc('record_booking_settlement', {
    p_host_id: hostId,
    p_booking_id: bookingId,
    p_gross_amount: grossAmount,
  });
  if (error) return { success: false, error: `Ledger settlement failed: ${error.message}` };

  const { data: entries, error: loadError } = await supabase
    .from('earnings_ledger_entries')
    .select('*')
    .eq('host_id', hostId)
    .in('source_ref', [`booking_payment:${bookingId}`, `platform_fee:${bookingId}`]);
  if (loadError) return { success: false, error: `Ledger settlement recorded but could not be read: ${loadError.message}` };

  const creditEntry = ((entries ?? []) as LedgerEntry[]).find((entry) => entry.entry_type === 'booking_payment') ?? null;
  const feeEntry = ((entries ?? []) as LedgerEntry[]).find((entry) => entry.entry_type === 'platform_fee') ?? null;

  await auditLogger.log({
    action: 'payment.confirmed',
    resourceType: 'payment',
    resourceId: bookingId,
    meta: { hostId, grossAmount, event: 'booking_settlement' },
  });

  return { success: true, data: { creditEntry, feeEntry } };
}

/**
 * Record an escrow release credit.
 *
 * @param hostId    - Host user ID
 * @param bookingId - UUID of the booking whose escrow was released
 * @param amount    - Amount released
 * @param txHash    - Optional Stellar transaction hash for the release
 */
export async function recordEscrowRelease(
  hostId: string,
  bookingId: string,
  amount: number,
  _txHash?: string,
): Promise<ServiceResponse<LedgerEntry | null>> {
  const result = await recordBookingSettlement(hostId, bookingId, amount);
  if (!result.success) return { success: false, error: result.error };
  return { success: true, data: result.data?.creditEntry ?? null };
}

/**
 * Record a refund debit (funds returned to tenant, deducted from host balance).
 *
 * @param hostId       - Host user ID
 * @param bookingId    - UUID of the cancelled/refunded booking
 * @param refundAmount - Amount refunded to the tenant
 * @param refundId     - Unique refund request ID for deduplication
 */
export async function recordRefundDebit(
  hostId: string,
  bookingId: string,
  refundAmount: number,
  refundId: string,
): Promise<ServiceResponse<LedgerEntry | null>> {
  return writeLedgerEntry({
    hostId,
    bookingId,
    entryType: 'refund_debit',
    direction:  'debit',
    amount:     refundAmount,
    sourceRef:  `refund_debit:${refundId}`,
  });
}

/**
 * Post an auditable adjustment entry.
 * Corrections never edit historical rows; instead a new entry is appended.
 *
 * @param hostId      - Host user ID
 * @param direction   - 'credit' to add funds, 'debit' to subtract
 * @param amount      - Adjustment amount
 * @param adminId     - Admin user ID posting the correction
 * @param adminNote   - Required free-text explanation for the audit trail
 * @param bookingId   - Optional booking this adjustment relates to
 */
export async function postAdjustment(
  hostId: string,
  direction: LedgerDirection,
  amount: number,
  adminId: string,
  adminNote: string,
  bookingId?: string,
): Promise<ServiceResponse<LedgerEntry | null>> {
  if (!adminNote || !adminNote.trim()) {
    return { success: false, error: 'adminNote is required for adjustments' };
  }

  // Unique source_ref per admin per second — prevents identical adjustments
  // from the same admin within the same second from creating duplicates.
  const ts = new Date().toISOString();
  const sourceRef = `adjustment:${adminId}:${ts}`;

  return writeLedgerEntry({
    hostId,
    bookingId: bookingId ?? null,
    entryType: 'adjustment',
    direction,
    amount,
    sourceRef,
    adminNote: adminNote.trim(),
  });
}

// ─── Balance queries ──────────────────────────────────────────────────────────

/**
 * Compute the balance for a host over a given period and (optionally) currency.
 *
 * Balances are derived from source events — no mutable summary column is used.
 */
export async function getHostLedgerBalance(
  hostId: string,
  filter: PeriodFilter,
): Promise<ServiceResponse<LedgerBalance>> {
  if (!hostId) return { success: false, error: 'hostId is required' };

  const dateError = validateDateRange(filter.from, filter.to);
  if (dateError) return { success: false, error: dateError };

  const currency = filter.currency ?? 'USDC';

  let query = supabase
    .from('earnings_ledger_entries')
    .select('direction, amount, currency')
    .eq('host_id', hostId)
    .eq('currency', currency)
    .gte('created_at', filter.from)
    .lte('created_at', filter.to);

  const { data, error } = await query;
  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as Array<{ direction: LedgerDirection; amount: number; currency: LedgerCurrency }>;

  let totalCredits = 0;
  let totalDebits  = 0;

  for (const row of rows) {
    const amt = Number(row.amount) || 0;
    if (row.direction === 'credit') totalCredits += amt;
    else                            totalDebits  += amt;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    success: true,
    data: {
      total_credits: round2(totalCredits),
      total_debits:  round2(totalDebits),
      net:           round2(totalCredits - totalDebits),
      currency,
      entry_count:   rows.length,
    },
  };
}

/**
 * List ledger entries for a host with optional period and currency filters.
 *
 * @param hostId - Host user ID
 * @param filter - Date range and optional currency filter
 * @param page   - 1-based page number (default 1)
 * @param limit  - Page size (default 50, max 200)
 */
export async function listLedgerEntries(
  hostId: string,
  filter: PeriodFilter,
  page = 1,
  limit = 50,
): Promise<ServiceResponse<{ entries: LedgerEntry[]; total: number }>> {
  if (!hostId) return { success: false, error: 'hostId is required' };

  const dateError = validateDateRange(filter.from, filter.to);
  if (dateError) return { success: false, error: dateError };

  const pageSize = Math.min(Math.max(1, limit), 200);
  const offset   = (Math.max(1, page) - 1) * pageSize;
  const currency = filter.currency ?? 'USDC';

  const { data, error, count } = await supabase
    .from('earnings_ledger_entries')
    .select('*', { count: 'exact' })
    .eq('host_id', hostId)
    .eq('currency', currency)
    .gte('created_at', filter.from)
    .lte('created_at', filter.to)
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1);

  if (error) return { success: false, error: error.message };

  return {
    success: true,
    data: {
      entries: (data ?? []) as LedgerEntry[],
      total:   count ?? 0,
    },
  };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Reconcile the ledger balance against settled booking totals in the DB.
 *
 * The check compares the ledger net (credits − debits, excluding adjustments)
 * against the sum of `total_price` for all Confirmed/Completed bookings that
 * belong to the host in the given period, minus the 5% platform fee.
 *
 * A non-zero `drift` signals that at least one booking was not recorded in the
 * ledger (or was recorded with a different amount).  Operators should post an
 * `adjustment` entry to correct it.
 */
export async function reconcileHostLedger(
  hostId: string,
  filter: PeriodFilter,
): Promise<ServiceResponse<LedgerReconciliationReport>> {
  if (!hostId) return { success: false, error: 'hostId is required' };

  const dateError = validateDateRange(filter.from, filter.to);
  if (dateError) return { success: false, error: dateError };

  const currency = filter.currency ?? 'USDC';

  // 1. Fetch all ledger entries for the period
  const entriesResult = await listLedgerEntries(hostId, filter, 1, 200);
  if (!entriesResult.success) return { success: false, error: entriesResult.error };

  const entries = [...entriesResult.data!.entries];
  const pageCount = Math.ceil(entriesResult.data!.total / 200);
  for (let page = 2; page <= pageCount; page++) {
    const nextPage = await listLedgerEntries(hostId, filter, page, 200);
    if (!nextPage.success) return { success: false, error: nextPage.error };
    entries.push(...nextPage.data!.entries);
  }
  const balance  = await getHostLedgerBalance(hostId, filter);
  if (!balance.success) return { success: false, error: balance.error };

  // 2. Sum settled bookings for the same period (ground truth from booking table)
  const { data: paymentRows, error: paymentErr } = await supabase
    .from('payments')
    .select('amount_stroops, booking:bookings!inner(properties!inner(owner_id))')
    .eq('status', 'confirmed')
    .eq('currency', currency)
    .eq('booking.properties.owner_id', hostId)
    .gte('updated_at', filter.from)
    .lte('updated_at', filter.to);

  if (paymentErr) return { success: false, error: paymentErr.message };

  const settledGross = ((paymentRows ?? []) as Array<{ amount_stroops: string | number }>)
    .reduce((sum, row) => sum + Number(row.amount_stroops) / 10_000_000, 0);

  const settledFee = Math.round(settledGross * PLATFORM_FEE_RATE * 10_000_000) / 10_000_000;
  const { data: refundRows, error: refundError } = await supabase
    .from('refund_requests')
    .select('refund_amount')
    .eq('host_id', hostId)
    .eq('currency', currency)
    .eq('status', 'confirmed')
    .gte('updated_at', filter.from)
    .lte('updated_at', filter.to);
  if (refundError) return { success: false, error: refundError.message };

  const confirmedRefunds = ((refundRows ?? []) as Array<{ refund_amount: number | string }>)
    .reduce((sum, row) => sum + Number(row.refund_amount), 0);
  const settledNet = Math.round((settledGross - settledFee - confirmedRefunds) * 10_000_000) / 10_000_000;

  // 3. Compare ledger net (excl. adjustments) vs settled net
  const ledgerNetWithoutAdjustments = entries
    .filter((e) => e.entry_type !== 'adjustment')
    .reduce(
      (sum, e) =>
        e.direction === 'credit' ? sum + Number(e.amount) : sum - Number(e.amount),
      0,
    );

  const drift      = Math.round((ledgerNetWithoutAdjustments - settledNet) * 100) / 100;
  const reconciled = drift === 0;

  return {
    success: true,
    data: {
      host_id:    hostId,
      from:       filter.from,
      to:         filter.to,
      currency,
      balance:    balance.data!,
      entries,
      reconciled,
      drift,
    },
  };
}
