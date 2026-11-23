import { AsyncLocalStorage } from 'node:async_hooks';
import { supabase } from '@/config/supabase.js';

// ─── Request correlation context ──────────────────────────────────────────────

/**
 * Per-request context propagated via AsyncLocalStorage so that any log call
 * made during a request's async call chain (controllers, services, blockchain
 * calls, Supabase queries) can be tagged with the same correlation id without
 * threading `req` through every function signature.
 */
export interface RequestLogContext {
  requestId: string;
  method?: string;
  path?: string;
  userId?: string;
  /** Business identifiers carried through the request for support correlation. */
  bookingId?: string;
  operationId?: string;
  /** Correlation id that survives retries/restarts (defaults to requestId). */
  correlationId?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestLogContext>();

/**
 * Run `callback` with `context` bound to the current async execution chain.
 * Called once per request by `requestIdMiddleware`.
 */
export function runWithRequestContext<T>(
  context: RequestLogContext,
  callback: () => T,
): T {
  return requestContextStorage.run(context, callback);
}

/** Returns the correlation context for the in-flight request, if any. */
export function getRequestContext(): RequestLogContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Attach the authenticated user id to the current request context once auth
 * middleware resolves it, so subsequent log calls in the same request include it.
 */
export function setRequestContextUserId(userId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.userId = userId;
}

/**
 * Attach business identifiers (booking/operation/correlation) to the current
 * request context so downstream logs and deferred work can be correlated.
 */
export function setRequestContextIdentifiers(ids: {
  bookingId?: string;
  operationId?: string;
  correlationId?: string;
}): void {
  const store = requestContextStorage.getStore();
  if (!store) return;
  if (ids.bookingId) store.bookingId = ids.bookingId;
  if (ids.operationId) store.operationId = ids.operationId;
  if (ids.correlationId) store.correlationId = ids.correlationId;
}

// ─── Redaction ────────────────────────────────────────────────────────────────

const REDACTED = '[REDACTED]';

/** Keys whose values must never be logged (auth headers, wallet/payment secrets). */
const SENSITIVE_KEY_PATTERN =
  /(authorization|auth|token|jwt|bearer|secret|private[_-]?key|mnemonic|seed|password|passwd|signature|api[_-]?key|card[_-]?number|cvv|cvc|pan|wallet[_-]?secret)/i;

/** Keys that indicate a full payment payload which should be summarised, not logged. */
const PAYMENT_PAYLOAD_KEY_PATTERN = /(payment|payload|raw[_-]?body|card|billing)/i;

const MAX_DEPTH = 6;

function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else if (PAYMENT_PAYLOAD_KEY_PATTERN.test(key) && val && typeof val === 'object') {
        // Never log full payment payloads — record only that one was present.
        out[key] = '[PAYMENT_PAYLOAD_REDACTED]';
      } else {
        out[key] = redactValue(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Strip auth headers, wallet secrets, and full payment payloads from an object
 * before it is written to logs or persisted. Returns a shallow-safe copy.
 */
export function redactForLogging<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return redactValue(input) as Record<string, unknown>;
}

export interface BlockchainOperationLog {
  operation: string;
  userId?: string;
  bookingId?: string;
  propertyId?: string;
  txHash?: string;
  escrowId?: string;
  error?: string;
  [key: string]: unknown;
}

class LoggingService {
  async logBlockchainOperation(
    operation: string,
    input: Record<string, unknown>,
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    const context = getRequestContext();

    const bookingId =
      (input.bookingId as string | undefined) ?? context?.bookingId;
    const operationId =
      (input.operationId as string | undefined) ?? context?.operationId;
    const correlationId = context?.correlationId ?? context?.requestId;

    const safeInput = redactForLogging(input);
    const safeResult = result ? redactForLogging(result) : undefined;

    try {
      const { error: dbError } = await supabase
        .from('blockchain_logs')
        .insert({
          operation,
          input_json: safeInput,
          result_json: safeResult || null,
          error_message: error || null,
          request_id: context?.requestId ?? null,
          correlation_id: correlationId ?? null,
          booking_id: bookingId ?? null,
          operation_id: operationId ?? null,
        });

      if (dbError) {
        console.error(`Failed to log blockchain operation ${operation}:`, dbError);
      }
    } catch (err) {
      console.error(`Error logging blockchain operation ${operation}:`, err);
    }

    const { error: errorMsg, ...rest } = { error, ...safeInput };
    const entry = {
      ...rest,
      requestId: context?.requestId,
      correlationId,
      bookingId,
      operationId,
      method: context?.method,
      path: context?.path,
      userId: context?.userId,
    };
    if (error) {
      console.error(`[Blockchain:${operation}] ERROR:`, errorMsg, JSON.stringify(entry));
    } else {
      console.log(`[Blockchain:${operation}]`, JSON.stringify(entry));
    }
  }
}

export const loggingService = new LoggingService();

// ─── Security event logger ────────────────────────────────────────────────────

type SecurityEvent =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'register_success'
  | 'token_revoked'
  | 'unauthorized_access'
  | 'rate_limit_exceeded';

class SecurityLogger {
  async logAuthEvent(
    event: SecurityEvent,
    userId?: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const context = getRequestContext();
    const entry = {
      event,
      userId: userId ?? context?.userId,
      requestId: context?.requestId,
      method: context?.method,
      path: context?.path,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    // Console output always
    if (event === 'login_failure' || event === 'unauthorized_access') {
      console.warn(`[Security:${event}]`, JSON.stringify(entry));
    } else {
      console.log(`[Security:${event}]`, JSON.stringify(entry));
    }

    // Persist to Supabase (best-effort)
    try {
      await supabase.from('security_logs').insert({
        event,
        user_id: userId || null,
        meta_json: meta || null,
      });
    } catch {
      // non-fatal — DB table may not exist yet
    }
  }
}

export const securityLogger = new SecurityLogger();
