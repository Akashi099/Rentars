import { syncAllBookings, syncAllProperties, reconcileAllPendingEscrows } from './sync.service.js';
import { purgeExpired as purgeExpiredIdempotencyKeys } from './idempotency.service.js';
import { processNotificationOutbox } from './notification.service.js';

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const NOTIFICATION_OUTBOX_INTERVAL_MS = 30 * 1000;
const MAX_CONCURRENT_RECONCILIATIONS = 5;
const INITIAL_BACKOFF_MS = 1000; // 1 second
const MAX_BACKOFF_MS = 30000; // 30 seconds

let concurrentReconciliations = 0;
let reconciliationBackoffMs = INITIAL_BACKOFF_MS;
let notificationOutboxRunning = false;

async function runSync(): Promise<void> {
  const propertiesResult = await syncAllProperties();
  if (propertiesResult.success) {
    console.log(
      `[sync] Properties: ${propertiesResult.data?.synced} synced, ${propertiesResult.data?.failed} failed`,
    );
  } else {
    console.error(`[sync] Property sync failed: ${propertiesResult.error}`);
  }

  const bookingsResult = await syncAllBookings();
  if (bookingsResult.success) {
    console.log(
      `[sync] Bookings: ${bookingsResult.data?.synced} synced, ${bookingsResult.data?.failed} failed`,
    );
  } else {
    console.error(`[sync] Booking sync failed: ${bookingsResult.error}`);
  }
}

async function runEscrowReconciliation(): Promise<void> {
  if (concurrentReconciliations >= MAX_CONCURRENT_RECONCILIATIONS) {
    console.log(`[reconcile] Skipping reconciliation — max concurrency (${MAX_CONCURRENT_RECONCILIATIONS}) reached`);
    return;
  }

  concurrentReconciliations++;

  try {
    const result = await reconcileAllPendingEscrows();
    if (result.success) {
      console.log(
        `[reconcile] Escrows: ${result.data?.reconciled} reconciled, ${result.data?.failed} failed`,
      );
      reconciliationBackoffMs = INITIAL_BACKOFF_MS;
    } else {
      console.error(`[reconcile] Reconciliation failed: ${result.error}`);
      reconciliationBackoffMs = Math.min(
        reconciliationBackoffMs * 2,
        MAX_BACKOFF_MS,
      );
    }
  } catch (err) {
    console.error('[reconcile] Scheduler error:', err);
    reconciliationBackoffMs = Math.min(
      reconciliationBackoffMs * 2,
      MAX_BACKOFF_MS,
    );
  } finally {
    concurrentReconciliations--;
  }
}

export function startSyncScheduler(): void {
  // Blockchain sync
  setInterval(() => {
    runSync().catch((err) => console.error('[sync] Scheduler error:', err));
  }, SYNC_INTERVAL_MS);

  setInterval(() => {
    runEscrowReconciliation().catch((err) => console.error('[reconcile] Scheduler error:', err));
  }, RECONCILIATION_INTERVAL_MS);

  setInterval(() => {
    runNotificationOutbox().catch((err) => console.error('[notification-outbox] Scheduler error:', err));
  }, NOTIFICATION_OUTBOX_INTERVAL_MS);

  // Idempotency-key cleanup — runs once per hour, purges records older than 24 h
  setInterval(() => {
    runIdempotencyCleanup().catch((err) => console.error('[idempotency] Cleanup error:', err));
  }, IDEMPOTENCY_CLEANUP_INTERVAL_MS);

  // Run an initial cleanup shortly after startup so stale keys don't linger
  // across a server restart that happens to be more than 24 h after creation.
  setTimeout(() => {
    runIdempotencyCleanup().catch((err) =>
      console.error('[idempotency] Initial cleanup error:', err),
    );
  }, 30_000); // 30 seconds after startup

  console.log(
    `[sync] Scheduler started — sync interval: ${SYNC_INTERVAL_MS / 1000}s, ` +
    `reconciliation interval: ${RECONCILIATION_INTERVAL_MS / 1000}s, ` +
    `idempotency cleanup interval: ${IDEMPOTENCY_CLEANUP_INTERVAL_MS / 1000}s`,
  );
}

async function runNotificationOutbox(): Promise<void> {
  if (notificationOutboxRunning) return;
  notificationOutboxRunning = true;
  try {
    const result = await processNotificationOutbox();
    if (!result.success) {
      console.error(`[notification-outbox] Dispatch failed: ${result.error}`);
    }
  } finally {
    notificationOutboxRunning = false;
  }
}

async function runIdempotencyCleanup(): Promise<void> {
  const result = await purgeExpiredIdempotencyKeys();
  if (result.success) {
    if ((result.data?.deleted ?? 0) > 0) {
      console.log(`[idempotency] Purged ${result.data?.deleted} expired idempotency key(s)`);
    }
  } else {
    console.error(`[idempotency] Cleanup failed: ${result.error}`);
  }
}
