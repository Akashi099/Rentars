/**
 * sync.service.ts — blockchain ↔ Supabase reconciliation.
 *
 * #611 additions:
 *  - Retry classification: transient vs permanent failures
 *  - Bounded retry threshold (MAX_RECONCILE_ATTEMPTS) with exponential backoff
 *  - `escrow_reconcile_failed` quarantine state after exhausting retries
 *  - Tenant + host notifications on permanent failure via notification.service.ts
 *  - Deduplication: reconcile attempt counter stored in DB; no duplicate
 *    escrow actions, refunds, or notifications sent
 */

import {
  BOOKING_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  STELLAR_RPC_URL,
} from '@/blockchain/config.js';
import { randomUUID } from 'node:crypto';
import { BookingClient } from '@/blockchain/bookingClient.js';
import { PropertyListingClient } from '@/blockchain/propertyListingClient.js';
import { getTransactionStatus } from '@/blockchain/transactionUtils.js';
import { getSorobanServer } from '@/blockchain/soroban.js';
import { supabase } from '@/config/supabase.js';
import { enqueueNotificationOutbox } from './notification.service.js';
import type { ServiceResponse } from './index.js';
import type { Booking as BookingDBRow } from '@/services/booking.service.js';

type SyncStatus = 'success' | 'failed' | 'skipped';

interface SyncLogEntry {
  entity_type: 'property' | 'booking';
  entity_id: string;
  status: SyncStatus;
  error_message?: string;
  synced_at: string;
}

async function writeSyncLog(entry: Omit<SyncLogEntry, 'synced_at'>): Promise<void> {
  const { error } = await supabase.from('sync_log').insert({ ...entry, synced_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to persist sync log: ${error.message}`);
}

function buildPropertyClient(): PropertyListingClient {
  return new PropertyListingClient(PROPERTY_LISTING_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

function buildBookingClient(): BookingClient {
  return new BookingClient(BOOKING_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

/**
 * Sync a single property from the blockchain to Supabase.
 *
 * Reads the on-chain listing by its property ID and updates the corresponding
 * row in the properties table with the latest title, description, price, and status.
 *
 * @param propertyId - On-chain property ID (u64 as a string)
 * @returns ServiceResponse indicating success or failure
 * @throws Does not throw; errors are returned in the ServiceResponse
 */
export async function syncPropertyFromChain(
  propertyId: string,
): Promise<ServiceResponse<void>> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildPropertyClient();
    const listing = await client.getListing(BigInt(propertyId));

    const { error } = await supabase
      .from('properties')
      .update({
        title: listing.title,
        description: listing.description,
        price_per_night: Number(listing.price_per_night) / 10_000_000,
        status: listing.status.toLowerCase(),
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(propertyId));

    if (error) {
      await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'failed', error_message: error.message });
      return { success: false, error: error.message };
    }

    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'success' });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    await writeSyncLog({ entity_type: 'property', entity_id: propertyId, status: 'failed', error_message: message });
    return { success: false, error: message };
  }
}

/**
 * Sync a single booking from the blockchain to Supabase.
 *
 * @param bookingId - On-chain booking ID (u64 as a string)
 * @returns ServiceResponse indicating success or failure
 */
export async function syncBookingFromChain(
  bookingId: string,
): Promise<ServiceResponse<void>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildBookingClient();
    const booking = await client.getBooking(BigInt(bookingId));

    const { error } = await supabase
      .from('bookings')
      .update({
        status: booking.status.toLowerCase(),
        escrow_id: booking.escrow_id || undefined,
        updated_at: new Date().toISOString(),
      })
      .eq('on_chain_id', Number(bookingId));

    if (error) {
      await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'failed', error_message: error.message });
      return { success: false, error: error.message };
    }

    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'success' });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    await writeSyncLog({ entity_type: 'booking', entity_id: bookingId, status: 'failed', error_message: message });
    return { success: false, error: message };
  }
}

/**
 * Sync every on-chain property listing to Supabase in sequential order.
 * Iterates from ID 1 to the current listing count.
 *
 * @returns ServiceResponse with counts of synced and failed properties
 * @example
 * const result = await syncAllProperties();
 * console.log(`Synced: ${result.data.synced}, Failed: ${result.data.failed}`);
 */
export async function syncAllProperties(): Promise<ServiceResponse<{ synced: number; failed: number }>> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    return { success: false, error: 'PROPERTY_LISTING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildPropertyClient();
    const count = await client.listingCount();

    let synced = 0;
    let failed = 0;

    for (let i = 1n; i <= count; i++) {
      const result = await syncPropertyFromChain(String(i));
      result.success ? synced++ : failed++;
    }

    return { success: true, data: { synced, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Sync every on-chain booking to Supabase in sequential order.
 * Iterates from ID 1 to the current booking count.
 *
 * @returns ServiceResponse with counts of synced and failed bookings
 */
export async function syncAllBookings(): Promise<ServiceResponse<{ synced: number; failed: number }>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const client = buildBookingClient();
    const count = await client.bookingCount();

    let synced = 0;
    let failed = 0;

    for (let i = 1n; i <= count; i++) {
      const result = await syncBookingFromChain(String(i));
      result.success ? synced++ : failed++;
    }

    return { success: true, data: { synced, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── #611 Reconciliation constants ───────────────────────────────────────────

/** Maximum number of reconciliation attempts before quarantining the booking. */
const MAX_RECONCILE_ATTEMPTS = 5;
const BASE_RECONCILE_BACKOFF_MS = 60_000;
const MAX_RECONCILE_BACKOFF_MS = 30 * 60_000;

/**
 * Errors that indicate a transient (retryable) failure.
 * Anything not matching is classified as permanent.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /rpc/i,
  /timeout/i,
  /econnreset/i,
  /enotfound/i,
  /fetch failed/i,
  /connection/i,
  /429/,
  /5\d\d/,
  /rate.?limit/i,
];

type ErrorCategory = 'transient' | 'permanent';

export function classifyError(message: string): ErrorCategory {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))
    ? 'transient'
    : 'permanent';
}

export function getReconciliationBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  return Math.min(BASE_RECONCILE_BACKOFF_MS * 2 ** exponent, MAX_RECONCILE_BACKOFF_MS);
}

// ─── Blockchain log helper ────────────────────────────────────────────────────

/**
 * Write a blockchain reconciliation log entry.
 */
async function writeBlockchainLog(entry: {
  booking_id: string;
  tx_hash?: string;
  log_type: 'reconciliation' | 'error' | 'success';
  message?: string;
  on_chain_status?: string;
  error_category?: ErrorCategory;
  attempt?: number;
}): Promise<void> {
  const { error } = await supabase.from('blockchain_logs').insert({
    ...entry,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Failed to persist blockchain log: ${error.message}`);
}

// ─── Tenant / host notification helpers ──────────────────────────────────────

/**
 * Fetch the tenant user ID for a booking.
 * Returns null if the booking or tenant cannot be resolved.
 */
async function getTenantId(bookingId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('tenant_id')
    .eq('id', bookingId)
    .single();
  if (error) throw new Error(`Failed to load tenant for booking ${bookingId}: ${error.message}`);
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

/**
 * Fetch the host (property owner) user ID for a booking.
 * Returns null if the booking or property cannot be resolved.
 */
async function getHostId(bookingId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('properties(owner_id)')
    .eq('id', bookingId)
    .single();
  if (error) throw new Error(`Failed to load host for booking ${bookingId}: ${error.message}`);
  // biome-ignore lint/suspicious/noExplicitAny: raw Supabase join shape
  return (data as any)?.properties?.owner_id ?? null;
}

/**
 * Send privacy-safe notifications to tenant and host after a permanent
 * escrow failure.
 *
 * Rules:
 *  - Only fires once per booking (checked via `escrow_failure_notified_at`).
 *  - Does not include internal error details (privacy-safe payload only).
 *  - Falls through on notification errors so reconciliation state is still saved.
 */
async function notifyEscrowFailure(bookingId: string, attempt: number): Promise<void> {
  // Check deduplication flag — never send twice
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('escrow_failure_notified_at, tenant_id, property_id')
    .eq('id', bookingId)
    .single();

  if (bookingError) throw new Error(`Failed to load escrow notification state: ${bookingError.message}`);
  if ((booking as { escrow_failure_notified_at?: string | null } | null)?.escrow_failure_notified_at) {
    // Already notified; skip
    return;
  }

  const tenantId = await getTenantId(bookingId);
  const hostId   = await getHostId(bookingId);

  const notificationPayload: Record<string, unknown> = {
    bookingId,
    // Privacy-safe: no internal error details, no wallet addresses
    message: 'Your booking escrow could not be confirmed after multiple attempts. Our support team has been alerted.',
    supportLink: '/support',
    attempt,
  };

  const deliveries: Array<Promise<ServiceResponse<void>>> = [];

  if (tenantId) {
    deliveries.push(
      enqueueNotificationOutbox(tenantId, 'system_alert', {
        ...notificationPayload,
        audience: 'tenant',
      }, `escrow-reconciliation-failed:${bookingId}:tenant`),
    );
  }

  if (hostId) {
    deliveries.push(
      enqueueNotificationOutbox(hostId, 'system_alert', {
        bookingId,
        message: 'An escrow transaction for one of your bookings could not be confirmed. Support has been alerted.',
        supportLink: '/host/support',
        attempt,
        audience: 'host',
      }, `escrow-reconciliation-failed:${bookingId}:host`),
    );
  }

  if (deliveries.length === 0) {
    throw new Error(`Cannot notify escrow failure for booking ${bookingId}: participants were not found`);
  }

  const results = await Promise.all(deliveries);
  const failed = results.find((result) => !result.success);
  if (failed) throw new Error(failed.error ?? 'Failed to enqueue escrow failure notification');

  // Mark as notified to prevent duplicate alerts
  const { error } = await supabase
    .from('bookings')
    .update({ escrow_failure_notified_at: new Date().toISOString() })
    .eq('id', bookingId);
  if (error) throw new Error(`Failed to mark booking as notified: ${error.message}`);
}

// ─── Core reconcile function ──────────────────────────────────────────────────

/**
 * Reconcile a single booking with pending escrow by polling transaction status.
 *
 * Enhanced for #611:
 *  - Increments `reconcile_attempts` counter on each call.
 *  - Classifies errors as transient or permanent.
 *  - After MAX_RECONCILE_ATTEMPTS, marks booking as `escrow_reconcile_failed`
 *    and sends privacy-safe notifications to tenant and host.
 *  - Never re-sends notifications if already sent (deduplication).
 */
async function reconcilePendingEscrow(
  booking: BookingDBRow & { escrow_hash?: string; reconcile_attempts?: number },
): Promise<void> {
  if (!booking.escrow_hash || !booking.on_chain_id) {
    return;
  }

  const currentAttempt = (booking.reconcile_attempts ?? 0) + 1;
  const attemptId = randomUUID();
  const { error: attemptInsertError } = await supabase
    .from('escrow_reconciliation_attempts')
    .insert({
      id: attemptId,
      booking_id: booking.id,
      attempt_number: currentAttempt,
      provider_event_id: booking.escrow_hash,
      status: 'pending',
    });
  if (attemptInsertError) {
    // A duplicate attempt number means another worker already claimed this run.
    if (attemptInsertError.code === '23505') return;
    throw new Error(`Failed to persist reconciliation attempt: ${attemptInsertError.message}`);
  }

  // Increment attempt counter first so even a transient failure is tracked
  const { error: attemptUpdateError } = await supabase
    .from('bookings')
    .update({
      reconcile_attempts: currentAttempt,
      last_reconcile_at: new Date().toISOString(),
      next_reconcile_at: null,
    })
    .eq('id', booking.id);
  if (attemptUpdateError) {
    throw new Error(`Failed to update reconciliation counter: ${attemptUpdateError.message}`);
  }

  try {
    const server = getSorobanServer();
    const txStatus = await getTransactionStatus(server, booking.escrow_hash);

    if (txStatus.status === 'not_found') {
      throw new Error(`Soroban status lookup failed: ${txStatus.error ?? 'unknown RPC error'}`);
    }

    if (txStatus.status === 'pending') {
      const nextRetryAt = new Date(Date.now() + getReconciliationBackoffMs(currentAttempt)).toISOString();
      const { error: attemptError } = await supabase
        .from('escrow_reconciliation_attempts')
        .update({
          error_category: 'transient',
          error_message: 'Transaction is not yet confirmed',
          next_retry_at: nextRetryAt,
        })
        .eq('id', attemptId);
      if (attemptError) throw new Error(`Failed to persist pending attempt: ${attemptError.message}`);

      const { error: bookingError } = await supabase
        .from('bookings')
        .update({ next_reconcile_at: nextRetryAt })
        .eq('id', booking.id);
      if (bookingError) throw new Error(`Failed to schedule pending reconciliation: ${bookingError.message}`);

      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'reconciliation',
        message: 'Transaction still pending',
        attempt: currentAttempt,
      });

      // Check if we've hit the attempt ceiling on a perpetually-pending tx
      if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
        const { error: attemptError } = await supabase
          .from('escrow_reconciliation_attempts')
          .update({ status: 'manual_review', next_retry_at: null })
          .eq('id', attemptId);
        if (attemptError) throw new Error(`Failed to mark pending attempt for manual review: ${attemptError.message}`);
        await quarantineBooking(
          booking.id,
          booking.escrow_hash,
          currentAttempt,
          'Exceeded max attempts while pending',
          attemptId,
        );
      }
      return;
    }

    if (txStatus.status === 'success') {
      const { error: bookingError } = await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          updated_at: new Date().toISOString(),
          next_reconcile_at: null,
          last_reconcile_error: null,
        })
        .eq('id', booking.id);
      if (bookingError) throw new Error(`Failed to mark escrow reconciled: ${bookingError.message}`);

      const { error: attemptError } = await supabase
        .from('escrow_reconciliation_attempts')
        .update({ status: 'succeeded', next_retry_at: null })
        .eq('id', attemptId);
      if (attemptError) throw new Error(`Failed to complete reconciliation attempt: ${attemptError.message}`);

      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'success',
        message: 'Escrow transaction confirmed',
        on_chain_status: 'funded',
        attempt: currentAttempt,
      });
      return;
    }

    if (txStatus.status === 'failed') {
      // Terminal on-chain failure — quarantine immediately
      const { error: attemptError } = await supabase
        .from('escrow_reconciliation_attempts')
        .update({
          status: 'manual_review',
          error_category: 'permanent',
          error_message: 'On-chain transaction failed',
          next_retry_at: null,
        })
        .eq('id', attemptId);
      if (attemptError) throw new Error(`Failed to record terminal escrow failure: ${attemptError.message}`);
      await quarantineBooking(
        booking.id,
        booking.escrow_hash,
        currentAttempt,
        'On-chain transaction failed',
        attemptId,
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    const category = classifyError(message);
    const nextRetryAt =
      category === 'transient' && currentAttempt < MAX_RECONCILE_ATTEMPTS
        ? new Date(Date.now() + getReconciliationBackoffMs(currentAttempt)).toISOString()
        : null;

    const { error: attemptError } = await supabase
      .from('escrow_reconciliation_attempts')
      .update({
        error_category: category,
        error_message: message,
        next_retry_at: nextRetryAt,
        status: nextRetryAt ? 'pending' : 'manual_review',
      })
      .eq('id', attemptId);
    if (attemptError) throw new Error(`Failed to persist reconciliation failure: ${attemptError.message}`);

    if (nextRetryAt) {
      const { error: scheduleError } = await supabase
        .from('bookings')
        .update({ next_reconcile_at: nextRetryAt, last_reconcile_error: message })
        .eq('id', booking.id);
      if (scheduleError) throw new Error(`Failed to schedule reconciliation retry: ${scheduleError.message}`);
    }

    await writeBlockchainLog({
      booking_id: booking.id,
      tx_hash: booking.escrow_hash,
      log_type: 'error',
      message: `Reconciliation error: ${message}`,
      error_category: category,
      attempt: currentAttempt,
    });

    if (!nextRetryAt) {
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, message, attemptId);
    }
    // Transient errors below the threshold are left in `pending` for retry
  }
}

/**
 * Move a booking to the `escrow_reconcile_failed` quarantine state and notify
 * participants.  Idempotent — safe to call multiple times.
 */
async function quarantineBooking(
  bookingId: string,
  txHash: string,
  attempt: number,
  reason: string,
  attemptId?: string,
): Promise<void> {
  const { error: bookingError } = await supabase
    .from('bookings')
    .update({
      status: 'escrow_reconcile_failed',
      last_reconcile_error: reason,
      next_reconcile_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId);
  if (bookingError) throw new Error(`Failed to quarantine booking: ${bookingError.message}`);

  if (attemptId) {
    const { error: attemptError } = await supabase
      .from('escrow_reconciliation_attempts')
      .update({ status: 'manual_review', next_retry_at: null })
      .eq('id', attemptId);
    if (attemptError) throw new Error(`Failed to mark reconciliation for manual review: ${attemptError.message}`);
  }

  await writeBlockchainLog({
    booking_id: bookingId,
    tx_hash: txHash,
    log_type: 'error',
    message: `Booking quarantined: ${reason}`,
    on_chain_status: 'escrow_reconcile_failed',
    attempt,
  });

  console.error(
    `[Reconcile] QUARANTINE booking=${bookingId} attempt=${attempt} reason="${reason}"`,
  );

  await notifyEscrowFailure(bookingId, attempt);
}

// ─── Public reconcile entry point ─────────────────────────────────────────────

/**
 * Reconcile all bookings with pending escrow transactions.
 *
 * Polls transaction status for every booking in `pending` state that has an
 * escrow hash AND has not yet exceeded MAX_RECONCILE_ATTEMPTS.
 *
 * @returns ServiceResponse with counts of reconciled bookings
 */
export async function reconcileAllPendingEscrows(): Promise<ServiceResponse<{ reconciled: number; failed: number }>> {
  if (!BOOKING_CONTRACT_ID) {
    return { success: false, error: 'BOOKING_CONTRACT_ID is not configured' };
  }

  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('status', 'pending')
      .not('escrow_hash', 'is', null)
      .lt('reconcile_attempts', MAX_RECONCILE_ATTEMPTS)
      .or(`next_reconcile_at.is.null,next_reconcile_at.lte.${new Date().toISOString()}`);

    if (error) {
      return { success: false, error: error.message };
    }

    let reconciled = 0;
    let failed = 0;

    for (const booking of bookings || []) {
      try {
        await reconcilePendingEscrow(
          booking as BookingDBRow & { escrow_hash?: string; reconcile_attempts?: number },
        );
        reconciled++;
      } catch (err) {
        failed++;
        console.error(`[reconcile] Failed to reconcile booking ${booking.id}:`, err);
      }
    }

    const { data: quarantinedBookings, error: quarantineError } = await supabase
      .from('bookings')
      .select('id, reconcile_attempts')
      .eq('status', 'escrow_reconcile_failed')
      .is('escrow_failure_notified_at', null);
    if (quarantineError) return { success: false, error: quarantineError.message };

    for (const booking of quarantinedBookings ?? []) {
      try {
        await notifyEscrowFailure(booking.id, booking.reconcile_attempts ?? 0);
      } catch (err) {
        failed++;
        console.error(`[reconcile] Failed to enqueue review notification for ${booking.id}:`, err);
      }
    }

    return { success: true, data: { reconciled, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
