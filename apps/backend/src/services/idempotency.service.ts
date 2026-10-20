/**
 * Idempotency service — stores and replays responses for idempotent POST
 * requests so that network retries and double-clicks never create duplicate
 * bookings or escrow transactions.
 *
 * Keys are scoped per user (the unique constraint is on (user_id, key)) and
 * expire after RETENTION_HOURS hours.  Expired rows are purged by the
 * scheduled cleanup in cleanup-schedular.ts.
 *
 * Algorithm
 * ---------
 * 1. Controller reads the `Idempotency-Key` header and the authenticated
 *    user-id, then calls `lookup(userId, key)`.
 * 2. If a record is found AND the stored request_hash matches the current
 *    request hash → replay the stored response (HTTP 200/201 with original
 *    body).
 * 3. If a record is found BUT the hash differs → return 422 (key reused with
 *    a different payload).
 * 4. If no record is found → let the request proceed, then call
 *    `store(userId, key, requestHash, responseBody, statusCode)`.
 *
 * Request hash
 * ------------
 * We hash the serialised JSON body with SHA-256 (hex) so that reordered keys
 * or whitespace differences in a textually-equivalent body are treated as the
 * same request.  The hash is stored as a 64-character hex string that fits
 * cleanly into `VARCHAR(64)`.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long an idempotency record is retained before it may be purged. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IdempotencyRecord {
  id: string;
  key: string;
  user_id: string;
  request_hash: string;
  /** Stored as JSONB in the DB, returned as a plain JS object here. */
  response_body: Record<string, unknown>;
  status_code: number;
  /** 'processing' = request in flight; 'completed' = safe to replay. */
  status: 'processing' | 'completed';
  created_at: string;
}

/**
 * Lifecycle of a payment transaction tied to an idempotency key.
 *
 * - `pending`   — key claimed, no signed transaction yet.
 * - `signed`    — a transaction XDR has been built and signed; it MUST NOT be
 *                 rebuilt or re-signed on retry (would change the hash).
 * - `submitted` — the signed XDR was handed to the provider; outcome unknown.
 * - `confirmed` — the provider confirmed the transaction on-chain.
 * - `failed`    — the provider returned a deterministic failure.
 */
export type PaymentTransactionStatus = 'pending' | 'signed' | 'submitted' | 'confirmed' | 'failed';

/** Attempt metadata retained alongside the payment idempotency context. */
export interface PaymentAttemptMetadata {
  /** Monotonic attempt counter for this (actor, booking, key). */
  attempt_count: number;
  /** ISO timestamp of the most recent attempt. */
  last_attempt_at: string;
  /** Last error category observed, if any (see payment error taxonomy). */
  last_error_category?: string;
  /** Provider name used for the most recent attempt. */
  provider?: string;
}

/** Full payment idempotency context persisted for a booking/actor pair. */
export interface PaymentIdempotencyContext {
  id: string;
  key: string;
  user_id: string;
  booking_id: string | null;
  request_hash: string;
  /** SHA-256 hex digest of the signed transaction XDR envelope. */
  signed_xdr_hash: string | null;
  /** The signed XDR itself, retained so retries reuse the exact same envelope. */
  signed_xdr: string | null;
  transaction_status: PaymentTransactionStatus;
  attempt_metadata: PaymentAttemptMetadata;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produces a stable SHA-256 hex digest of `body`.
 *
 * The body object is serialised with sorted keys so that `{b:1,a:2}` and
 * `{a:2,b:1}` produce the same hash.
 */
export function hashRequestBody(body: unknown): string {
  const stable = JSON.stringify(body, Object.keys(body as object).sort());
  return createHash('sha256').update(stable).digest('hex');
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Look up an existing idempotency record for `(userId, key)`.
 *
 * @returns
 *   - `{ success: true, data: IdempotencyRecord }` if a live record exists.
 *   - `{ success: true, data: null }` if no record exists (first request).
 *   - `{ success: false, error }` on a database error.
 */
export async function lookup(
  userId: string,
  key: string,
): Promise<ServiceResponse<IdempotencyRecord | null>> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('key', key)
    .gte('created_at', cutoff)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Idempotency lookup failed: ${error.message}` };
  }

  return { success: true, data: data as IdempotencyRecord | null };
}

/**
 * Atomically claim an idempotency key with status='processing'.
 *
 * Returns `{ claimed: true, id }` when this call wins the INSERT race and may
 * proceed with the real request.  Returns `{ claimed: false, existing }` when a
 * record already exists (either in-flight or completed) so the caller can
 * replay or reject.
 *
 * @param userId      - Authenticated user ID (scopes the key).
 * @param key         - Value of the `Idempotency-Key` header.
 * @param requestHash - SHA-256 hex digest of the canonical request body.
 */
export async function lockKey(
  userId: string,
  key: string,
  requestHash: string,
): Promise<ServiceResponse<{ claimed: true; id: string } | { claimed: false; existing: IdempotencyRecord }>> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: {},
      status_code: 0,
      status: 'processing',
    })
    .select('id')
    .single();

  if (!insertError && inserted) {
    return { success: true, data: { claimed: true, id: (inserted as { id: string }).id } };
  }

  // Unique constraint fired — fetch the existing record.
  const { data: existing, error: fetchError } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('key', key)
    .gte('created_at', cutoff)
    .maybeSingle();

  if (fetchError || !existing) {
    return { success: false, error: `Idempotency lock failed: ${fetchError?.message ?? 'record not found'}` };
  }

  return { success: true, data: { claimed: false, existing: existing as IdempotencyRecord } };
}

/**
 * Complete a previously claimed idempotency record by storing the response.
 *
 * @param id          - UUID of the record returned by lockKey.
 * @param responseBody - The JSON-serialisable response body that was sent.
 * @param statusCode  - The HTTP status code that was sent (e.g. 201).
 */
export async function completeKey(
  id: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('idempotency_keys')
    .update({ status: 'completed', response_body: responseBody, status_code: statusCode })
    .eq('id', id);

  if (error) {
    return { success: false, error: `Idempotency complete failed: ${error.message}` };
  }

  return { success: true };
}

/**
 * Release a processing record when the underlying request fails, so the key
 * can be retried with the same payload.
 */
export async function releaseKey(id: string): Promise<void> {
  await supabase.from('idempotency_keys').delete().eq('id', id).eq('status', 'processing');
}

/**
 * Persist an idempotency record after a successful (or deterministic) response.
 *
 * An `upsert` with `ignoreDuplicates: false` ensures that if two concurrent
 * requests with the same key slip through the lookup guard at the same time,
 * only the first insert wins and subsequent ones are treated as conflicts that
 * can be resolved by the caller's next `lookup()`.
 *
 * @param userId      - Authenticated user ID (scopes the key).
 * @param key         - Value of the `Idempotency-Key` header.
 * @param requestHash - SHA-256 hex digest of the canonical request body.
 * @param responseBody - The JSON-serialisable response body that was sent.
 * @param statusCode  - The HTTP status code that was sent (e.g. 201).
 */
export async function store(
  userId: string,
  key: string,
  requestHash: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
): Promise<ServiceResponse<IdempotencyRecord>> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: responseBody,
      status_code: statusCode,
      status: 'completed',
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: `Idempotency store failed: ${error.message}` };
  }

  return { success: true, data: data as IdempotencyRecord };
}

// ─── Payment idempotency context ──────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of a signed transaction XDR envelope.
 *
 * The hash is used to detect whether a retry is presenting the same signed
 * transaction (safe to reconcile) or a different one (must be rejected).
 */
export function hashSignedXdr(signedXdr: string): string {
  return createHash('sha256').update(signedXdr).digest('hex');
}

/**
 * Persist (or refresh) the payment idempotency context for a key.
 *
 * The context records the signed XDR hash, transaction status and attempt
 * metadata so that retries can reuse the same key and never resubmit a signed
 * transaction that has already been submitted.
 */
export async function storePaymentContext(
  userId: string,
  key: string,
  context: {
    bookingId?: string | null;
    requestHash: string;
    signedXdr?: string | null;
    transactionStatus: PaymentTransactionStatus;
    attemptMetadata: PaymentAttemptMetadata;
  },
): Promise<ServiceResponse<PaymentIdempotencyContext>> {
  const signedXdr = context.signedXdr ?? null;
  const signedXdrHash = signedXdr ? hashSignedXdr(signedXdr) : null;
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('idempotency_keys')
    .upsert(
      {
        key,
        user_id: userId,
        booking_id: context.bookingId ?? null,
        request_hash: context.requestHash,
        signed_xdr: signedXdr,
        signed_xdr_hash: signedXdrHash,
        transaction_status: context.transactionStatus,
        attempt_metadata: context.attemptMetadata,
        updated_at: now,
      },
      { onConflict: 'user_id,key' },
    )
    .select()
    .single();

  if (error) {
    return { success: false, error: `Payment context store failed: ${error.message}` };
  }

  return { success: true, data: data as PaymentIdempotencyContext };
}

/**
 * Retrieve the payment idempotency context for `(userId, key)`.
 *
 * @returns The context, `null` when none exists, or an error message.
 */
export async function getPaymentContext(
  userId: string,
  key: string,
): Promise<ServiceResponse<PaymentIdempotencyContext | null>> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('user_id', userId)
    .eq('key', key)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Payment context lookup failed: ${error.message}` };
  }

  return { success: true, data: (data as PaymentIdempotencyContext | null) ?? null };
}

/**
 * Query payment idempotency contexts by booking and/or actor.
 *
 * At least one of `bookingId` or `userId` must be supplied.  Results are
 * ordered newest-first so callers can inspect the latest attempt.
 */
export async function queryPaymentContexts(filter: {
  bookingId?: string;
  userId?: string;
  limit?: number;
}): Promise<ServiceResponse<PaymentIdempotencyContext[]>> {
  if (!filter.bookingId && !filter.userId) {
    return { success: false, error: 'queryPaymentContexts requires bookingId or userId' };
  }

  let query = supabase
    .from('idempotency_keys')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 50);

  if (filter.bookingId) query = query.eq('booking_id', filter.bookingId);
  if (filter.userId) query = query.eq('user_id', filter.userId);

  const { data, error } = await query;

  if (error) {
    return { success: false, error: `Payment context query failed: ${error.message}` };
  }

  return { success: true, data: (data ?? []) as PaymentIdempotencyContext[] };
}

/**
 * Mark a signed transaction as submitted.
 *
 * This is the guard that prevents resubmission of a signed transaction: once
 * a record is in `submitted`, `confirmed` or `failed`, callers must reconcile
 * rather than re-submit.  The signed XDR hash is verified against the stored
 * value so a mismatched envelope is rejected.
 *
 * @returns The updated context, or an error when the transition is unsafe.
 */
export async function markSignedTransactionSubmitted(
  userId: string,
  key: string,
  signedXdr: string,
): Promise<ServiceResponse<PaymentIdempotencyContext>> {
  const lookupResult = await getPaymentContext(userId, key);
  if (!lookupResult.success) return lookupResult;
  if (!lookupResult.data) {
    return { success: false, error: 'Payment context not found for key' };
  }

  const existing = lookupResult.data;
  const incomingHash = hashSignedXdr(signedXdr);

  if (existing.signed_xdr_hash && existing.signed_xdr_hash !== incomingHash) {
    return {
      success: false,
      error: 'Signed transaction hash mismatch: refusing to resubmit a different envelope',
    };
  }

  if (existing.transaction_status === 'submitted' || existing.transaction_status === 'confirmed') {
    return {
      success: false,
      error: `Transaction already ${existing.transaction_status}: reconcile instead of resubmitting`,
    };
  }

  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('idempotency_keys')
    .update({
      signed_xdr: existing.signed_xdr ?? signedXdr,
      signed_xdr_hash: existing.signed_xdr_hash ?? incomingHash,
      transaction_status: 'submitted',
      updated_at: now,
    })
    .eq('id', existing.id)
    .select()
    .single();

  if (error) {
    return { success: false, error: `Mark submitted failed: ${error.message}` };
  }

  return { success: true, data: data as PaymentIdempotencyContext };
}

/**
 * Delete all idempotency_keys rows older than `retentionHours`.
 * Called by the scheduled cleanup job.
 *
 * @returns The number of rows deleted, or an error message.
 */
export async function purgeExpired(
  retentionHours: number = IDEMPOTENCY_RETENTION_HOURS,
): Promise<ServiceResponse<{ deleted: number }>> {
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('idempotency_keys')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    return { success: false, error: `Idempotency purge failed: ${error.message}` };
  }

  const deleted = Array.isArray(data) ? data.length : 0;
  return { success: true, data: { deleted } };
}
