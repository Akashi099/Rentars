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
 *
 * Correlation
 * -----------
 * Each record also persists the originating `correlation_id`, `booking_id`
 * and `operation_id` so that deferred work (queue records, retries, workers)
 * can restore the operation context after a restart.  These are non-secret
 * identifiers only — auth headers, wallet secrets and full payment payloads
 * are never persisted or logged here.
 */

import { createHash } from 'node:crypto';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long an idempotency record is retained before it may be purged. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Non-secret identifiers that tie a request to its asynchronous work.
 * All fields are optional so callers that do not yet have them can omit them.
 */
export interface CorrelationContext {
  /** Request-scoped correlation id (e.g. from `X-Correlation-Id`). */
  correlation_id?: string | null;
  /** Booking id created or referenced by the request, if any. */
  booking_id?: string | null;
  /** Operation id for the deferred unit of work, if any. */
  operation_id?: string | null;
}

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
  /** Correlation id of the originating request (nonsecret). */
  correlation_id: string | null;
  /** Booking id associated with the request, if any (nonsecret). */
  booking_id: string | null;
  /** Operation id for deferred work, if any (nonsecret). */
  operation_id: string | null;
  created_at: string;
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

/** Keys whose values must never be persisted or logged. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'auth',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'wallet_secret',
  'private_key',
  'seed_phrase',
  'mnemonic',
  'password',
  'card_number',
  'cvv',
  'cvc',
  'payment_payload',
  'payment_credentials',
]);

/**
 * Recursively redact sensitive values from a response body before it is
 * persisted.  Auth headers, wallet secrets and full payment payloads are
 * replaced with `'[REDACTED]'` so they can never leak into the idempotency
 * store (and therefore never into replay responses or logs).
 */
export function redactForStorage(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactForStorage(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactForStorage(v);
    }
    return out;
  }
  return value;
}

/** Normalise a correlation context, coercing missing values to `null`. */
function normaliseCorrelation(ctx?: CorrelationContext): Required<CorrelationContext> {
  return {
    correlation_id: ctx?.correlation_id ?? null,
    booking_id: ctx?.booking_id ?? null,
    operation_id: ctx?.operation_id ?? null,
  };
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
 * @param correlation - Nonsecret correlation identifiers to persist so that
 *                      deferred work can restore the operation context.
 */
export async function lockKey(
  userId: string,
  key: string,
  requestHash: string,
  correlation?: CorrelationContext,
): Promise<ServiceResponse<{ claimed: true; id: string } | { claimed: false; existing: IdempotencyRecord }>> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const ctx = normaliseCorrelation(correlation);

  const { data: inserted, error: insertError } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: {},
      status_code: 0,
      status: 'processing',
      correlation_id: ctx.correlation_id,
      booking_id: ctx.booking_id,
      operation_id: ctx.operation_id,
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
 * @param correlation - Optional correlation identifiers to persist/update
 *                      (e.g. a booking_id discovered while handling the request).
 */
export async function completeKey(
  id: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
  correlation?: CorrelationContext,
): Promise<ServiceResponse<void>> {
  const update: Record<string, unknown> = {
    status: 'completed',
    response_body: redactForStorage(responseBody),
    status_code: statusCode,
  };

  if (correlation) {
    const ctx = normaliseCorrelation(correlation);
    if (ctx.correlation_id !== null) update.correlation_id = ctx.correlation_id;
    if (ctx.booking_id !== null) update.booking_id = ctx.booking_id;
    if (ctx.operation_id !== null) update.operation_id = ctx.operation_id;
  }

  const { error } = await supabase
    .from('idempotency_keys')
    .update(update)
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
 * @param correlation - Nonsecret correlation identifiers to persist.
 */
export async function store(
  userId: string,
  key: string,
  requestHash: string,
  responseBody: Record<string, unknown>,
  statusCode: number,
  correlation?: CorrelationContext,
): Promise<ServiceResponse<IdempotencyRecord>> {
  const ctx = normaliseCorrelation(correlation);

  const { data, error } = await supabase
    .from('idempotency_keys')
    .insert({
      key,
      user_id: userId,
      request_hash: requestHash,
      response_body: redactForStorage(responseBody),
      status_code: statusCode,
      status: 'completed',
      correlation_id: ctx.correlation_id,
      booking_id: ctx.booking_id,
      operation_id: ctx.operation_id,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: `Idempotency store failed: ${error.message}` };
  }

  return { success: true, data: data as IdempotencyRecord };
}

/**
 * Restore the correlation context for a previously stored record.
 *
 * Workers and retry jobs call this to reattach the originating request,
 * booking and operation identifiers after a restart, without needing access to
 * the original request (and therefore without touching auth headers or
 * payment payloads).
 *
 * @returns `{ success: true, data: CorrelationContext }` when the record
 *          exists, or `{ success: false, error }` otherwise.
 */
export async function getCorrelation(
  id: string,
): Promise<ServiceResponse<CorrelationContext>> {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('correlation_id, booking_id, operation_id')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return { success: false, error: `Idempotency correlation lookup failed: ${error.message}` };
  }
  if (!data) {
    return { success: false, error: 'Idempotency record not found' };
  }

  const row = data as Pick<IdempotencyRecord, 'correlation_id' | 'booking_id' | 'operation_id'>;
  return {
    success: true,
    data: {
      correlation_id: row.correlation_id ?? null,
      booking_id: row.booking_id ?? null,
      operation_id: row.operation_id ?? null,
    },
  };
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
