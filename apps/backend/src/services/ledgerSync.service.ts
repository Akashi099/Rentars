/**
 * ledgerSync.service.ts — replay-safe blockchain event processing.
 *
 * Provides the building blocks for idempotent ledger-event workers:
 *
 *  1. **Event inbox** — record an event as "received" before projection so a
 *     worker restart cannot skip events already delivered to the inbox.
 *  2. **Idempotency check** — before applying side effects, verify the event
 *     has not already been projected.  Duplicate delivery (from replay or
 *     redelivery) is silently skipped.
 *  3. **Cursor persistence** — workers save their last-processed sequence/ID so
 *     they can resume from a known point after a restart rather than
 *     reprocessing from the beginning.
 *  4. **Lag measurement** — exposes the difference between the latest on-chain
 *     sequence and the worker's cursor so operators can alert on stale workers.
 *  5. **Dead-letter management** — events that exhaust retries are quarantined
 *     with full context; operators can inspect and re-queue them.
 *
 * Database tables required:
 *
 *   ledger_event_inbox (
 *     event_key       TEXT PRIMARY KEY,   -- unique ID for this event
 *     worker_id       TEXT NOT NULL,
 *     received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     projected_at    TIMESTAMPTZ,        -- NULL until successfully projected
 *     attempts        INT NOT NULL DEFAULT 0,
 *     last_error      TEXT,
 *     status          TEXT NOT NULL DEFAULT 'received'
 *                     CHECK (status IN ('received','projected','dead_letter')),
 *     correlation_id  TEXT,               -- originating request correlation ID
 *     booking_id      TEXT,               -- originating booking (if any)
 *     operation_id    TEXT                -- originating operation (if any)
 *   );
 *
 *   ledger_sync_cursors (
 *     cursor_key      TEXT PRIMARY KEY,
 *     last_value      TEXT NOT NULL,      -- opaque; typically a bigint or hash
 *     updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type InboxStatus = 'received' | 'projected' | 'dead_letter';

export interface InboxRecord {
    event_key: string;
    worker_id: string;
    received_at: string;
    projected_at: string | null;
    attempts: number;
    last_error: string | null;
    status: InboxStatus;
    correlation_id: string | null;
    booking_id: string | null;
    operation_id: string | null;
}

/**
 * Correlation identifiers carried through asynchronous work.
 *
 * Persisted on the inbox record so a worker that restarts (or a retry that
 * runs in a different process) can restore the originating operation context.
 * All values are nonsecret identifiers — never tokens or payment credentials.
 */
export interface CorrelationContext {
    correlationId?: string | null;
    bookingId?: string | null;
    operationId?: string | null;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Normalise a user-supplied identifier before it is persisted or logged.
 *
 * Returns null when the value is missing or does not look like an opaque ID,
 * so arbitrary user input can never leak into logs or the inbox table.
 */
export function sanitizeCorrelationId(value: string | null | undefined): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    if (!CORRELATION_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

/**
 * Build a log-safe correlation suffix, e.g. ` correlation_id=abc booking_id=42`.
 * Missing identifiers are omitted; values are sanitised first.
 */
export function formatCorrelationContext(context: CorrelationContext): string {
    const parts: string[] = [];
    const correlationId = sanitizeCorrelationId(context.correlationId);
    const bookingId = sanitizeCorrelationId(context.bookingId);
    const operationId = sanitizeCorrelationId(context.operationId);
    if (correlationId) parts.push(`correlation_id=${correlationId}`);
    if (bookingId) parts.push(`booking_id=${bookingId}`);
    if (operationId) parts.push(`operation_id=${operationId}`);
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
    /(authorization|auth|token|secret|password|passwd|private[_-]?key|mnemonic|seed|wallet|signature|api[_-]?key|credential|card|cvv|pan|iban|payment[_-]?payload)/i;

/**
 * Recursively redact secrets from a value before it is logged.
 *
 * Removes auth headers, wallet secrets, and full payment payloads while
 * preserving the shape of the object for debugging.
 */
export function redactForLog(value: unknown, depth = 0): unknown {
    if (depth > 6) return REDACTED;
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        return value.length > 512 ? `${value.slice(0, 512)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => redactForLog(item, depth + 1));
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactForLog(entry, depth + 1);
        }
        return out;
    }
    return REDACTED;
}

export interface CursorRecord {
    cursor_key: string;
    last_value: string;
    updated_at: string;
}

export interface LagReport {
    cursor_key: string;
    cursor_value: bigint;
    latest_on_chain: bigint;
    lag: bigint;
}

// ─── Event Inbox ──────────────────────────────────────────────────────────────

/**
 * Record an event as received in the inbox before projection begins.
 *
 * Uses INSERT with ON CONFLICT DO NOTHING so duplicate deliveries for an
 * event_key that has already been received are silently ignored.  This is safe
 * to call multiple times for the same event_key.
 *
 * @returns true  if this is the first time the event was received (new row).
 * @returns false if the event_key already existed (duplicate; skip processing).
 */
export async function recordEventInbox(
    eventKey: string,
    workerId: string,
    context: CorrelationContext = {},
): Promise<ServiceResponse<{ isNew: boolean }>> {
    const { data, error } = await supabase
        .from('ledger_event_inbox')
        .upsert(
            {
                event_key: eventKey,
                worker_id: workerId,
                received_at: new Date().toISOString(),
                status: 'received',
                attempts: 0,
                correlation_id: sanitizeCorrelationId(context.correlationId),
                booking_id: sanitizeCorrelationId(context.bookingId),
                operation_id: sanitizeCorrelationId(context.operationId),
            },
            { onConflict: 'event_key', ignoreDuplicates: true },
        )
        .select('event_key')
        .maybeSingle();

    if (error) {
        return { success: false, error: `Failed to record event inbox: ${error.message}` };
    }

    return { success: true, data: { isNew: data !== null } };
}

/**
 * Check whether an event has already been successfully projected.
 *
 * Call this after recordEventInbox and before applying any side effects.
 * Returns true when the event can be safely skipped.
 */
export async function isEventProjected(
    eventKey: string,
): Promise<ServiceResponse<boolean>> {
    const { data, error } = await supabase
        .from('ledger_event_inbox')
        .select('status')
        .eq('event_key', eventKey)
        .maybeSingle();

    if (error) {
        return { success: false, error: `Failed to check event status: ${error.message}` };
    }

    const alreadyProjected = (data as InboxRecord | null)?.status === 'projected';
    return { success: true, data: alreadyProjected };
}

/**
 * Restore the persisted correlation context for an event.
 *
 * Workers call this after a restart (or when picking up a deferred retry) so
 * downstream logs and provider calls retain the originating operation context.
 */
export async function loadEventCorrelation(
    eventKey: string,
): Promise<ServiceResponse<CorrelationContext>> {
    const { data, error } = await supabase
        .from('ledger_event_inbox')
        .select('correlation_id, booking_id, operation_id')
        .eq('event_key', eventKey)
        .maybeSingle();

    if (error) {
        return { success: false, error: `Failed to load event correlation: ${error.message}` };
    }

    const record = data as InboxRecord | null;
    return {
        success: true,
        data: {
            correlationId: record?.correlation_id ?? null,
            bookingId: record?.booking_id ?? null,
            operationId: record?.operation_id ?? null,
        },
    };
}

/**
 * Mark an event as successfully projected.
 *
 * Call this inside the same database transaction (or immediately after) the
 * domain-state write so the inbox record and the projection are atomic.
 */
export async function markEventProjected(
    eventKey: string,
): Promise<ServiceResponse<void>> {
    const { error } = await supabase
        .from('ledger_event_inbox')
        .update({
            status: 'projected',
            projected_at: new Date().toISOString(),
        })
        .eq('event_key', eventKey);

    if (error) {
        return { success: false, error: `Failed to mark event projected: ${error.message}` };
    }

    return { success: true };
}

/**
 * Increment the attempt counter and record the last error for an event.
 *
 * Call this when projection fails before deciding whether to quarantine.
 */
export async function recordEventAttemptFailure(
    eventKey: string,
    errorMessage: string,
): Promise<ServiceResponse<{ attempts: number }>> {
    const { data: current, error: fetchError } = await supabase
        .from('ledger_event_inbox')
        .select('attempts')
        .eq('event_key', eventKey)
        .maybeSingle();

    if (fetchError) {
        return { success: false, error: `Failed to fetch attempt count: ${fetchError.message}` };
    }

    const attempts = ((current as InboxRecord | null)?.attempts ?? 0) + 1;

    const { error } = await supabase
        .from('ledger_event_inbox')
        .update({ attempts, last_error: errorMessage })
        .eq('event_key', eventKey);

    if (error) {
        return { success: false, error: `Failed to record attempt failure: ${error.message}` };
    }

    return { success: true, data: { attempts } };
}

/**
 * Move an event to the dead-letter state after exhausting retries.
 *
 * Idempotent — calling this multiple times for the same key is safe.
 */
export async function quarantineEvent(
    eventKey: string,
    reason: string,
    context: CorrelationContext = {},
): Promise<ServiceResponse<void>> {
    const { error } = await supabase
        .from('ledger_event_inbox')
        .update({
            status: 'dead_letter',
            last_error: reason,
        })
        .eq('event_key', eventKey);

    if (error) {
        return { success: false, error: `Failed to quarantine event: ${error.message}` };
    }

    console.error(
        `[LedgerSync] DEAD_LETTER event_key=${eventKey}${formatCorrelationContext(context)} reason="${reason}"`,
    );
    return { success: true };
}

// ─── Cursor Management ────────────────────────────────────────────────────────

/**
 * Persist the worker's cursor so it can resume from this point after a restart.
 *
 * `cursorKey` identifies the worker (e.g. `"booking_sync"`, `"property_sync"`).
 * `value` is the last successfully processed sequence number or event ID.
 */
export async function saveCursor(
    cursorKey: string,
    value: string,
): Promise<ServiceResponse<void>> {
    const { error } = await supabase
        .from('ledger_sync_cursors')
        .upsert(
            {
                cursor_key: cursorKey,
                last_value: value,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'cursor_key' },
        );

    if (error) {
        return { success: false, error: `Failed to save cursor: ${error.message}` };
    }

    return { success: true };
}

/**
 * Load the worker's saved cursor.
 *
 * Returns null when no cursor exists (worker starting from scratch).
 */
export async function loadCursor(
    cursorKey: string,
): Promise<ServiceResponse<string | null>> {
    const { data, error } = await supabase
        .from('ledger_sync_cursors')
        .select('last_value')
        .eq('cursor_key', cursorKey)
        .maybeSingle();

    if (error) {
        return { success: false, error: `Failed to load cursor: ${error.message}` };
    }

    return { success: true, data: (data as CursorRecord | null)?.last_value ?? null };
}

// ─── Lag Measurement ─────────────────────────────────────────────────────────

/**
 * Measure how far behind the worker is relative to the latest on-chain event.
 *
 * Both `cursorValue` and `latestOnChain` are treated as unsigned integers
 * (bigint) representing monotonically increasing sequence numbers.
 *
 * A lag of 0 means the worker is fully caught up.
 * A large lag signals a stalled worker that may need intervention.
 */
export function measureLag(cursorKey: string, cursorValue: bigint, latestOnChain: bigint): LagReport {
    const lag = latestOnChain > cursorValue ? latestOnChain - cursorValue : 0n;
    return { cursor_key: cursorKey, cursor_value: cursorValue, latest_on_chain: latestOnChain, lag };
}

/**
 * Emit a structured lag log line including the worker's correlation context.
 *
 * Used by sync workers so operators can tie a stalled cursor back to the
 * originating request/booking/operation without exposing secrets.
 */
export function logLagReport(report: LagReport, context: CorrelationContext = {}): void {
    console.info(
        `[LedgerSync] LAG cursor_key=${report.cursor_key} cursor_value=${report.cursor_value} ` +
            `latest_on_chain=${report.latest_on_chain} lag=${report.lag}${formatCorrelationContext(context)}`,
    );
}

// ─── Dead-Letter Inspection ───────────────────────────────────────────────────

/**
 * Return all events currently in the dead-letter queue for a given worker.
 *
 * If `workerId` is omitted, returns all dead-lettered events across workers.
 */
export async function listDeadLetterEvents(
    workerId?: string,
): Promise<ServiceResponse<InboxRecord[]>> {
    let query = supabase
        .from('ledger_event_inbox')
        .select('*')
        .eq('status', 'dead_letter')
        .order('received_at', { ascending: true });

    if (workerId) {
        query = query.eq('worker_id', workerId);
    }

    const { data, error } = await query;

    if (error) {
        return { success: false, error: `Failed to list dead-letter events: ${error.message}` };
    }

    return { success: true, data: (data ?? []) as InboxRecord[] };
}

/**
 * Re-queue a dead-lettered event for reprocessing by resetting its status to
 * `received` and clearing its error and attempt count.
 *
 * The caller is responsible for re-driving the event through the projection
 * pipeline after calling this function.
 */
export async function retryDeadLetterEvent(
    eventKey: string,
): Promise<ServiceResponse<void>> {
    const { error } = await supabase
        .from('ledger_event_inbox')
        .update({
            status: 'received',
            attempts: 0,
            last_error: null,
            projected_at: null,
        })
        .eq('event_key', eventKey)
        .eq('status', 'dead_letter');

    if (error) {
        return { success: false, error: `Failed to retry dead-letter event: ${error.message}` };
    }

    return { success: true };
}

// ─── Idempotent Projection Helper ─────────────────────────────────────────────

/**
 * High-level helper that combines inbox receipt, idempotency check, projection,
 * and failure tracking into a single call.
 *
 * Usage:
 * ```ts
 * await processEventOnce(
 *   { eventKey: 'booking:created:42', workerId: 'booking_sync' },
 *   async () => {
 *     // apply side effects — called at most once per eventKey
 *     await applyBookingCreated(event);
 *   },
 *   { maxAttempts: 5 },
 * );
 * ```
 *
 * @param eventKey   - Globally unique key for this event (e.g. `"booking:42:created"`).
 * @param workerId   - Identifier for the calling worker.
 * @param project    - Async function that applies the domain side effects.
 * @param maxAttempts - Quarantine after this many failed attempts.
 */
export async function processEventOnce(
    {
        eventKey,
        workerId,
        correlationId,
        bookingId,
        operationId,
    }: { eventKey: string; workerId: string } & CorrelationContext,
    project: (context: CorrelationContext) => Promise<void>,
    { maxAttempts = 5 }: { maxAttempts?: number } = {},
): Promise<ServiceResponse<{ outcome: 'projected' | 'skipped' | 'dead_letter' }>> {
    // 1. Record in inbox — idempotent; duplicate delivery → isNew = false.
    //    Correlation IDs are persisted so a restart can restore the context.
    const inboxResult = await recordEventInbox(eventKey, workerId, {
        correlationId,
        bookingId,
        operationId,
    });
    if (!inboxResult.success) {
        return { success: false, error: inboxResult.error };
    }

    // 2. Check if already projected (covers restarts that skip the inbox insert)
    const projectedResult = await isEventProjected(eventKey);
    if (!projectedResult.success) {
        return { success: false, error: projectedResult.error };
    }
    if (projectedResult.data) {
        return { success: true, data: { outcome: 'skipped' } };
    }

    // 3. Restore correlation context from the inbox record.  On a fresh
    //    delivery this matches the caller's values; after a restart it is the
    //    only source of truth, so prefer the persisted record when present.
    const storedResult = await loadEventCorrelation(eventKey);
    const context: CorrelationContext = storedResult.success
        ? {
              correlationId: storedResult.data.correlationId ?? sanitizeCorrelationId(correlationId),
              bookingId: storedResult.data.bookingId ?? sanitizeCorrelationId(bookingId),
              operationId: storedResult.data.operationId ?? sanitizeCorrelationId(operationId),
          }
        : {
              correlationId: sanitizeCorrelationId(correlationId),
              bookingId: sanitizeCorrelationId(bookingId),
              operationId: sanitizeCorrelationId(operationId),
          };

    // 4. Attempt projection
    try {
        await project(context);

        const markResult = await markEventProjected(eventKey);
        if (!markResult.success) {
            console.error(
                `[LedgerSync] Failed to mark ${eventKey} projected${formatCorrelationContext(context)}: ${markResult.error}`,
            );
        }

        return { success: true, data: { outcome: 'projected' } };
    } catch (err) {
        const message = (err as Error).message;
        const failureResult = await recordEventAttemptFailure(eventKey, message);

        if (!failureResult.success) {
            return { success: false, error: failureResult.error };
        }

        if (failureResult.data.attempts >= maxAttempts) {
            await quarantineEvent(eventKey, message, context);
            return { success: true, data: { outcome: 'dead_letter' } };
        }

        console.warn(
            `[LedgerSync] Projection failed event_key=${eventKey} attempt=${failureResult.data.attempts}` +
                `${formatCorrelationContext(context)} error=${JSON.stringify(redactForLog(message))}`,
        );

        return {
            success: false,
            error: `Projection failed (attempt ${failureResult.data.attempts})${formatCorrelationContext(context)}: ${message}`,
        };
    }
}
