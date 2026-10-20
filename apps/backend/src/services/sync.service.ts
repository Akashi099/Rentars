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
import {
  assertCertificationEnvironment,
  createCertificationRun,
  type CertificationRun,
} from './certification.service.js';
import { BookingClient } from '@/blockchain/bookingClient.js';
import { PropertyListingClient } from '@/blockchain/propertyListingClient.js';
import { getTransactionStatus } from '@/blockchain/transactionUtils.js';
import { getSorobanServer } from '@/blockchain/soroban.js';
import { supabase } from '@/config/supabase.js';
import { createNotification } from './notification.service.js';
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
  await supabase.from('sync_log').insert({ ...entry, synced_at: new Date().toISOString() });
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

/**
 * Errors that indicate a transient (retryable) failure.
 * Anything not matching is classified as permanent.
 */
const TRANSIENT_ERROR_PATTERNS = [
  /network/i,
  /timeout/i,
  /econnreset/i,
  /enotfound/i,
  /503/,
  /502/,
  /rate.?limit/i,
];

type ErrorCategory = 'transient' | 'permanent';

function classifyError(message: string): ErrorCategory {
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(message))
    ? 'transient'
    : 'permanent';
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
  await supabase.from('blockchain_logs').insert({
    ...entry,
    created_at: new Date().toISOString(),
  });
}

// ─── Tenant / host notification helpers ──────────────────────────────────────

/**
 * Fetch the tenant user ID for a booking.
 * Returns null if the booking or tenant cannot be resolved.
 */
async function getTenantId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('tenant_id')
    .eq('id', bookingId)
    .single();
  return (data as { tenant_id?: string } | null)?.tenant_id ?? null;
}

/**
 * Fetch the host (property owner) user ID for a booking.
 * Returns null if the booking or property cannot be resolved.
 */
async function getHostId(bookingId: string): Promise<string | null> {
  const { data } = await supabase
    .from('bookings')
    .select('properties(owner_id)')
    .eq('id', bookingId)
    .single();
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
  const { data: booking } = await supabase
    .from('bookings')
    .select('escrow_failure_notified_at, tenant_id, property_id')
    .eq('id', bookingId)
    .single();

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

  const tasks: Promise<unknown>[] = [];

  if (tenantId) {
    tasks.push(
      createNotification(tenantId, 'system_alert', {
        ...notificationPayload,
        audience: 'tenant',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify tenant ${tenantId}:`, err)
      ),
    );
  }

  if (hostId) {
    tasks.push(
      createNotification(hostId, 'system_alert', {
        bookingId,
        message: 'An escrow transaction for one of your bookings could not be confirmed. Support has been alerted.',
        supportLink: '/host/support',
        attempt,
        audience: 'host',
      }).catch((err) =>
        console.error(`[Reconcile] Failed to notify host ${hostId}:`, err)
      ),
    );
  }

  await Promise.all(tasks);

  // Mark as notified to prevent duplicate alerts
  await supabase
    .from('bookings')
    .update({ escrow_failure_notified_at: new Date().toISOString() })
    .eq('id', bookingId);
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

  // Increment attempt counter first so even a transient failure is tracked
  await supabase
    .from('bookings')
    .update({
      reconcile_attempts: currentAttempt,
      last_reconcile_at: new Date().toISOString(),
    })
    .eq('id', booking.id);

  try {
    const server = getSorobanServer();
    const txStatus = await getTransactionStatus(server, booking.escrow_hash);

    if (txStatus.status === 'pending') {
      await writeBlockchainLog({
        booking_id: booking.id,
        tx_hash: booking.escrow_hash,
        log_type: 'reconciliation',
        message: 'Transaction still pending',
        attempt: currentAttempt,
      });

      // Check if we've hit the attempt ceiling on a perpetually-pending tx
      if (currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
        await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, 'Exceeded max attempts while pending');
      }
      return;
    }

    if (txStatus.status === 'success') {
      await supabase
        .from('bookings')
        .update({
          status: 'confirmed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id);

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
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, 'On-chain transaction failed');
    }
  } catch (err) {
    const message = (err as Error).message;
    const category = classifyError(message);

    await writeBlockchainLog({
      booking_id: booking.id,
      tx_hash: booking.escrow_hash,
      log_type: 'error',
      message: `Reconciliation error: ${message}`,
      error_category: category,
      attempt: currentAttempt,
    });

    if (category === 'permanent' || currentAttempt >= MAX_RECONCILE_ATTEMPTS) {
      await quarantineBooking(booking.id, booking.escrow_hash, currentAttempt, message);
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
): Promise<void> {
  await supabase
    .from('bookings')
    .update({
      status: 'escrow_reconcile_failed',
      last_reconcile_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bookingId);

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
      .lt('reconcile_attempts', MAX_RECONCILE_ATTEMPTS); // skip exhausted bookings

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

    return { success: true, data: { reconciled, failed } };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// ─── #773 Testnet certification harness ──────────────────────────────────────

/**
 * Reconcile a single booking by ID as part of a certification run.
 *
 * Unlike {@link reconcileAllPendingEscrows}, this targets one booking so the
 * certification suite can assert on the exact sync event produced.  The run id
 * is attached to every blockchain log entry so certification transactions can
 * be traced and cleaned up deterministically.
 *
 * @param run - Certification run context (carries the unique run id)
 * @param bookingId - Supabase booking row id
 * @returns ServiceResponse with the resulting sync status and log reference
 */
export async function reconcileBookingForCertification(
  run: CertificationRun,
  bookingId: string,
): Promise<ServiceResponse<{ status: SyncStatus; syncEventId: string | null }>> {
  assertCertificationEnvironment();

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('id', bookingId)
    .single();

  if (error || !booking) {
    return { success: false, error: error?.message ?? `Booking ${bookingId} not found` };
  }

  try {
    await reconcilePendingEscrow(
      booking as BookingDBRow & { escrow_hash?: string; reconcile_attempts?: number },
    );

    const { data: logRow } = await supabase
      .from('blockchain_logs')
      .insert({
        booking_id: bookingId,
        tx_hash: (booking as { escrow_hash?: string }).escrow_hash,
        log_type: 'reconciliation',
        message: `Certification reconcile run ${run.runId}`,
        attempt: (booking as { reconcile_attempts?: number }).reconcile_attempts ?? 0,
        certification_run_id: run.runId,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    return {
      success: true,
      data: {
        status: 'success',
        syncEventId: (logRow as { id?: string } | null)?.id ?? null,
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    await writeSyncLog({
      entity_type: 'booking',
      entity_id: bookingId,
      status: 'failed',
      error_message: `[cert:${run.runId}] ${message}`,
    });
    return { success: false, error: message };
  }
}

/**
 * Run the full reconciliation certification pass for a set of bookings.
 *
 * Each booking is reconciled individually and its sync event reference is
 * captured so failures can be reported against the exact booking, transaction,
 * and sync event.  The run id tags every log entry for deterministic cleanup.
 *
 * @param run - Certification run context
 * @param bookingIds - Booking row ids to reconcile
 * @returns ServiceResponse with per-booking results
 */
export async function certifyReconciliation(
  run: CertificationRun,
  bookingIds: string[],
): Promise<ServiceResponse<Array<{ bookingId: string; status: SyncStatus; syncEventId: string | null; error?: string }>>> {
  assertCertificationEnvironment();

  const results: Array<{ bookingId: string; status: SyncStatus; syncEventId: string | null; error?: string }> = [];

  for (const bookingId of bookingIds) {
    const result = await reconcileBookingForCertification(run, bookingId);
    if (result.success) {
      results.push({ bookingId, ...result.data });
    } else {
      results.push({ bookingId, status: 'failed', syncEventId: null, error: result.error });
    }
  }

  const anyFailed = results.some((r) => r.status === 'failed');
  return anyFailed
    ? { success: false, error: 'One or more bookings failed reconciliation certification', data: results }
    : { success: true, data: results };
}

/**
 * Convenience entry point used by the certification suite: provisions a run
 * context and reconciles the supplied bookings under it.
 */
export async function runReconciliationCertification(
  bookingIds: string[],
): Promise<ServiceResponse<Array<{ bookingId: string; status: SyncStatus; syncEventId: string | null; error?: string }>>> {
  const run = createCertificationRun();
  return certifyReconciliation(run, bookingIds);
}
