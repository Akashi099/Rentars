import { getJwtSecret } from '@/config/jwtSecret.js';
import { supabase } from '@/config/supabase.js';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { auditLogger } from './auditLogger.service.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Booking statuses that represent an open financial obligation. A user with any
 * of these cannot have their account deleted: the escrow or dispute would be
 * stranded without a counterparty able to act on it.
 */
export const ACTIVE_OBLIGATION_STATUSES = ['Pending', 'Confirmed', 'Disputed'] as const;

export interface DataExportRequest {
  id: string;
  user_id: string;
  status: 'pending' | 'completed' | 'failed';
  export_url?: string;
  requested_at: string;
  completed_at?: string;
  expires_at: string;
  error_message?: string;
}

export interface DeletionRequest {
  id: string;
  user_id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  requested_at: string;
  cancelled_at?: string;
  completed_at?: string;
  cancel_token: string;
  cancel_expires_at: string;
  error_message?: string;
  last_blocked_reason?: string;
}

export interface ActiveObligation {
  booking_id: string;
  status: (typeof ACTIVE_OBLIGATION_STATUSES)[number];
  role: 'tenant' | 'host';
}

/** Thrown when a deletion would strand open bookings, escrow, or disputes. */
export class DeletionBlockedError extends Error {
  readonly code = 'ACTIVE_OBLIGATIONS';
  constructor(readonly obligations: ActiveObligation[]) {
    super(
      `Account has ${obligations.length} open booking(s); resolve them before deleting the account`
    );
    this.name = 'DeletionBlockedError';
  }
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const { data: userData, error } = await supabase
    .from('users')
    .select('password_hash')
    .eq('id', userId)
    .single();

  if (error || !userData?.password_hash) return false;

  const bcrypt = await import('bcrypt');
  return bcrypt.compare(password, userData.password_hash);
}

/**
 * Returns every open booking the user is party to, either as tenant or as the
 * host of the property. Fails closed: a query error throws rather than
 * reporting "no obligations".
 */
export async function getActiveFinancialObligations(userId: string): Promise<ActiveObligation[]> {
  const statuses = [...ACTIVE_OBLIGATION_STATUSES];

  const [asTenant, asHost] = await Promise.all([
    supabase.from('bookings').select('id, status').eq('tenant_id', userId).in('status', statuses),
    supabase
      .from('bookings')
      .select('id, status, properties!inner(owner_id)')
      .eq('properties.owner_id', userId)
      .in('status', statuses),
  ]);

  if (asTenant.error || asHost.error) {
    throw new Error('Failed to check active obligations');
  }

  const tenantRows: ActiveObligation[] = (asTenant.data ?? []).map((row) => ({
    booking_id: row.id,
    status: row.status,
    role: 'tenant',
  }));
  const hostRows: ActiveObligation[] = (asHost.data ?? []).map((row) => ({
    booking_id: row.id,
    status: row.status,
    role: 'host',
  }));

  return [...tenantRows, ...hostRows];
}

export async function requestDataExport(userId: string, ip: string): Promise<DataExportRequest> {
  const exportId = uuid();
  const requestedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();

  const { data, error } = await supabase
    .from('data_exports')
    .insert({
      id: exportId,
      user_id: userId,
      status: 'pending',
      requested_at: requestedAt,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create export request: ${error.message}`);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.data_export_requested',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { export_id: exportId },
  });

  return data;
}

/**
 * Generates the export payload for a pending request and stores it on the
 * request row. Runs detached from the HTTP request; on failure the row is
 * marked `failed` so the client can see it and request again.
 */
export async function processDataExport(userId: string, exportId: string): Promise<void> {
  try {
    const payload = await generateDataExport(userId);

    const { error } = await supabase
      .from('data_exports')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        export_payload: payload,
      })
      .eq('id', exportId)
      .eq('user_id', userId);

    if (error) throw new Error(error.message);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await supabase
      .from('data_exports')
      .update({ status: 'failed', error_message: message })
      .eq('id', exportId)
      .eq('user_id', userId);
  }
}

/**
 * Returns the request, and the payload only when it is completed and not yet
 * expired. Expired payloads are never returned even if the cleanup job has not
 * run yet.
 */
export async function getDataExportStatus(
  userId: string,
  exportId: string
): Promise<(DataExportRequest & { export_payload?: Record<string, unknown> }) | null> {
  const { data } = await supabase
    .from('data_exports')
    .select('*')
    .eq('id', exportId)
    .eq('user_id', userId)
    .single();

  if (!data) return null;

  const expired = new Date(data.expires_at) < new Date();
  if (data.status === 'completed' && !expired) {
    return data;
  }

  const { export_payload: _payload, ...rest } = data;
  return rest;
}

/** Documents what the export contains and what it deliberately omits. */
export const EXPORT_DATA_CATEGORIES = [
  { category: 'profile', source: 'profiles', included: true },
  { category: 'bookings', source: 'bookings (as tenant)', included: true },
  { category: 'reviews', source: 'reviews (as author)', included: true },
  { category: 'messages', source: 'messages (as sender)', included: true },
  { category: 'notification_preferences', source: 'notification_preferences', included: true },
  { category: 'password_hash', source: 'users', included: false, reason: 'credential' },
  {
    category: 'blockchain_records',
    source: 'Stellar ledger',
    included: false,
    reason: 'immutable public ledger',
  },
] as const;

export async function generateDataExport(userId: string): Promise<Record<string, unknown>> {
  const [profileResult, bookingsResult, reviewsResult, messagesResult, notificationPrefsResult] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase
        .from('bookings')
        .select(
          'id, property_id, check_in, check_out, guest_count, total_price, status, terms_version, terms_accepted_at, created_at'
        )
        .eq('tenant_id', userId),
      supabase
        .from('reviews')
        .select('id, property_id, rating, comment, created_at')
        .eq('author_id', userId),
      supabase
        .from('messages')
        .select('id, recipient_id, content, created_at')
        .eq('sender_id', userId),
      supabase.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle(),
    ]);

  for (const result of [
    profileResult,
    bookingsResult,
    reviewsResult,
    messagesResult,
    notificationPrefsResult,
  ]) {
    if (result.error && result.error.code !== 'PGRST116') {
      throw new Error(`Export query failed: ${result.error.message}`);
    }
  }

  return {
    export_version: 1,
    exported_at: new Date().toISOString(),
    data_categories: EXPORT_DATA_CATEGORIES,
    note: 'Blockchain records (wallet addresses, transaction hashes, on-chain IDs) are permanently public on the Stellar ledger and are not included here. They cannot be deleted.',
    profile: profileResult.data ?? null,
    bookings: bookingsResult.data ?? [],
    reviews: reviewsResult.data ?? [],
    messages: messagesResult.data ?? [],
    notification_preferences: notificationPrefsResult.data ?? null,
  };
}

/**
 * Creates a pending deletion request. Refuses while open obligations exist, and
 * returns the existing pending request if one is already open (idempotent).
 */
export async function requestAccountDeletion(userId: string, ip: string): Promise<DeletionRequest> {
  const obligations = await getActiveFinancialObligations(userId);
  if (obligations.length > 0) {
    throw new DeletionBlockedError(obligations);
  }

  const { data: existing } = await supabase
    .from('account_deletions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .maybeSingle();

  if (existing) return existing;

  const deletionId = uuid();
  const requestedAt = new Date().toISOString();
  const cancelExpiresAt = new Date(Date.now() + SEVEN_DAYS_MS).toISOString();
  const cancelToken = jwt.sign({ deletion_id: deletionId, user_id: userId }, getJwtSecret(), {
    expiresIn: '7d',
  });

  const { data, error } = await supabase
    .from('account_deletions')
    .insert({
      id: deletionId,
      user_id: userId,
      status: 'pending',
      requested_at: requestedAt,
      confirmed_at: requestedAt,
      cancel_token: cancelToken,
      cancel_expires_at: cancelExpiresAt,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create deletion request: ${error.message}`);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_requested',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { deletion_id: deletionId },
  });

  return data;
}

export async function getDeletionRequest(
  userId: string,
  deletionId: string
): Promise<DeletionRequest | null> {
  const { data } = await supabase
    .from('account_deletions')
    .select('*')
    .eq('id', deletionId)
    .eq('user_id', userId)
    .single();

  return data || null;
}

export async function cancelAccountDeletion(
  userId: string,
  deletionId: string,
  ip: string
): Promise<boolean> {
  const now = new Date().toISOString();

  const { data: deletion, error: fetchError } = await supabase
    .from('account_deletions')
    .select('*')
    .eq('id', deletionId)
    .eq('user_id', userId)
    .single();

  if (fetchError || !deletion) return false;

  if (deletion.status !== 'pending') return false;

  if (new Date(deletion.cancel_expires_at) < new Date()) return false;

  const { error: updateError } = await supabase
    .from('account_deletions')
    .update({
      status: 'cancelled',
      cancelled_at: now,
    })
    .eq('id', deletionId)
    .eq('status', 'pending');

  if (updateError) return false;

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_cancelled',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { deletion_id: deletionId },
  });

  return true;
}

export type DeletionOutcome = 'completed' | 'blocked';

/**
 * Anonymises the account. Re-checks obligations first, because bookings may
 * have opened between the request and the window closing. A blocked deletion
 * stays pending and records why, so the worker retries it later.
 *
 * Every step is idempotent, so a transient failure can be retried safely.
 */
export async function executeAccountDeletion(
  userId: string,
  deletionId: string,
  ip: string
): Promise<DeletionOutcome> {
  const obligations = await getActiveFinancialObligations(userId);
  if (obligations.length > 0) {
    await supabase
      .from('account_deletions')
      .update({
        last_blocked_reason: `${obligations.length} open booking(s)`,
      })
      .eq('id', deletionId);
    return 'blocked';
  }

  const deletedEmail = `deleted-${userId}@rentars.invalid`;
  const now = new Date().toISOString();

  const { error: userError } = await supabase
    .from('users')
    .update({
      email: deletedEmail,
      status: 'deleted',
      email_verified: false,
    })
    .eq('id', userId);

  if (userError) {
    throw new Error(`Failed to anonymise account: ${userError.message}`);
  }

  const { error: profileError } = await supabase
    .from('profiles')
    .update({
      display_name: 'Deleted User',
      avatar_url: null,
      bio: null,
      stellar_address: null,
      phone: null,
      location: null,
    })
    .eq('id', userId);

  if (profileError) {
    throw new Error(`Failed to wipe profile: ${profileError.message}`);
  }

  // Transient data with no retention requirement.
  const transientTables = [
    'notifications',
    'notification_preferences',
    'push_subscriptions',
    'refresh_tokens',
    'saved_searches',
  ] as const;
  for (const table of transientTables) {
    const { error } = await supabase.from(table).delete().eq('user_id', userId);
    if (error) throw new Error(`Failed to delete ${table}: ${error.message}`);
  }

  // Export payloads hold a full copy of the personal data, so clear them now.
  const { error: exportError } = await supabase
    .from('data_exports')
    .update({ export_payload: null })
    .eq('user_id', userId);
  if (exportError) throw new Error(`Failed to clear export payloads: ${exportError.message}`);

  const { error: completeError } = await supabase
    .from('account_deletions')
    .update({
      status: 'completed',
      completed_at: now,
      anonymised_at: now,
      last_blocked_reason: null,
    })
    .eq('id', deletionId);

  if (completeError) {
    throw new Error(`Failed to record deletion completion: ${completeError.message}`);
  }

  await auditLogger.log({
    actorId: userId,
    action: 'privacy.account_deletion_completed',
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: {
      deletion_id: deletionId,
      retained: ['bookings', 'payments', 'audit_logs', 'blockchain_records'],
    },
  });

  return 'completed';
}

export interface DueDeletionSummary {
  processed: number;
  completed: number;
  blocked: number;
  failed: number;
}

/**
 * Worker entry point: executes every pending deletion whose cancellation window
 * has closed. One failure does not stop the rest of the batch.
 */
export async function processDueAccountDeletions(
  now: Date = new Date(),
  batchSize = 100
): Promise<DueDeletionSummary> {
  const { data, error } = await supabase
    .from('account_deletions')
    .select('id, user_id')
    .eq('status', 'pending')
    .lt('cancel_expires_at', now.toISOString())
    .limit(batchSize);

  if (error) throw new Error(`Failed to load due deletions: ${error.message}`);

  const summary: DueDeletionSummary = { processed: 0, completed: 0, blocked: 0, failed: 0 };

  for (const row of data ?? []) {
    summary.processed += 1;
    try {
      const outcome = await executeAccountDeletion(row.user_id, row.id, 'worker');
      if (outcome === 'completed') summary.completed += 1;
      else summary.blocked += 1;
    } catch (err) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error('[privacy] Deletion failed for', row.user_id, message);
      await supabase.from('account_deletions').update({ error_message: message }).eq('id', row.id);
    }
  }

  return summary;
}
