import { supabase } from '../config/supabase.js';
import { connectRedis } from '../config/redis.js';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

/**
 * Correlation context propagated through retries so that every attempt can be
 * traced back to the originating request, booking, and operation (issue #100).
 * All values must be non-secret identifiers; never pass tokens or credentials.
 */
export interface RetryCorrelationContext {
  requestId?: string;
  bookingId?: string;
  operationKey?: string;
  providerReference?: string;
}

/**
 * Classification of a failed attempt:
 * - `transient`: safe to retry (network blip, 5xx, timeout before acceptance).
 * - `ambiguous`: outcome unknown (e.g. timeout after the provider may have
 *   accepted). Must NOT be retried blindly; reconcile provider state first.
 * - `permanent`: retrying cannot help (validation, 4xx, business rule).
 */
export type RetryFailureClass = 'transient' | 'ambiguous' | 'permanent';

export interface OperationRetryOptions extends RetryOptions {
  /** Durable operation key; all attempts are tied to this key. */
  operationKey: string;
  /** Correlation identifiers propagated into logs. */
  correlation?: RetryCorrelationContext;
  /**
   * Classify a thrown error. Defaults to `transient` for backward
   * compatibility, but callers performing financial operations must supply a
   * classifier so ambiguous outcomes are never retried blindly.
   */
  classifyError?: (error: unknown) => RetryFailureClass;
  /**
   * Called before a retry is scheduled after an ambiguous failure. Should
   * query provider state and return `true` only when it is safe to retry.
   */
  reconcileAmbiguous?: (error: unknown) => Promise<boolean>;
  /** Optional logger override (defaults to console). */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export class AmbiguousOperationError extends Error {
  constructor(
    message: string,
    public readonly operationKey: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AmbiguousOperationError';
  }
}

export class OperationRetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly operationKey: string,
    public readonly attempts: number,
    public readonly lastError?: unknown
  ) {
    super(message);
    this.name = 'OperationRetryExhaustedError';
  }
}

/**
 * Build a redacted, log-safe correlation prefix. Only non-secret identifiers
 * are emitted; any unexpected fields are ignored.
 */
export function formatCorrelation(context?: RetryCorrelationContext): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.requestId) parts.push(`requestId=${context.requestId}`);
  if (context.bookingId) parts.push(`bookingId=${context.bookingId}`);
  if (context.operationKey) parts.push(`operationKey=${context.operationKey}`);
  if (context.providerReference) parts.push(`providerRef=${context.providerReference}`);
  return parts.length > 0 ? `[${parts.join(' ')}] ` : '';
}
=======

// ─── Fallback defaults (used when env vars are absent or malformed) ────────────
const FALLBACK_MAX_ATTEMPTS = 5;
const FALLBACK_INITIAL_DELAY_MS = 1000;
const FALLBACK_MAX_DELAY_MS = 30000;
const FALLBACK_BACKOFF_MULTIPLIER = 2;

/**
 * Parse an integer from a string, returning `fallback` if the result is not a
 * finite positive integer.  Handles NaN, Infinity, zero, and negatives.
 *
 * Fixes issue #479: zero or negative attempt count from env would skip all
 * retries; malformed values would produce NaN and unpredictable behaviour.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/**
 * Parse a non-negative finite integer (0 is allowed for delay values so the
 * caller can disable waiting).
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: parsePositiveInt(process.env.STARTUP_RETRY_ATTEMPTS, FALLBACK_MAX_ATTEMPTS),
  initialDelayMs: parseNonNegativeInt(process.env.STARTUP_RETRY_INITIAL_DELAY_MS, FALLBACK_INITIAL_DELAY_MS),
  maxDelayMs: parseNonNegativeInt(process.env.STARTUP_RETRY_MAX_DELAY_MS, FALLBACK_MAX_DELAY_MS),
  backoffMultiplier: FALLBACK_BACKOFF_MULTIPLIER,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next backoff delay in milliseconds.
 *
 * Uses safe arithmetic to prevent the exponential calculation from producing
 * `Infinity` or `NaN` before `Math.min` is applied (issue #480).  When the
 * intermediate result overflows to a non-finite number it is clamped directly
 * to `maxDelayMs`, so no retry delay can ever be infinite or negative.
 */
export function calculateNextDelay(attempt: number, options: Required<RetryOptions>): number {
  const exponentialDelay = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  // Guard against Infinity / NaN produced by large attempt counts or multipliers.
  const safeDelay = Number.isFinite(exponentialDelay) ? exponentialDelay : options.maxDelayMs;
  return Math.min(safeDelay, options.maxDelayMs);
}

async function probeSupabase(): Promise<boolean> {
  const { error } = await supabase
    .from('properties')
    .select('id', { count: 'exact', head: true });
  return !error;
}

async function probeRedis(): Promise<boolean> {
  try {
    await connectRedis();
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize caller-supplied options so that invalid values (zero, negative,
 * NaN, Infinity) fall back to the configured defaults (issue #479).
 */
function normalizeOptions(options: RetryOptions): Required<RetryOptions> {
  const base = DEFAULT_RETRY_OPTIONS;
  return {
    maxAttempts:
      options.maxAttempts !== undefined
        ? (Number.isFinite(options.maxAttempts) && options.maxAttempts >= 1
            ? Math.floor(options.maxAttempts)
            : base.maxAttempts)
        : base.maxAttempts,
    initialDelayMs:
      options.initialDelayMs !== undefined
        ? (Number.isFinite(options.initialDelayMs) && options.initialDelayMs >= 0
            ? Math.floor(options.initialDelayMs)
            : base.initialDelayMs)
        : base.initialDelayMs,
    maxDelayMs:
      options.maxDelayMs !== undefined
        ? (Number.isFinite(options.maxDelayMs) && options.maxDelayMs >= 0
            ? Math.floor(options.maxDelayMs)
            : base.maxDelayMs)
        : base.maxDelayMs,
    backoffMultiplier:
      options.backoffMultiplier !== undefined
        ? (Number.isFinite(options.backoffMultiplier) && options.backoffMultiplier > 0
            ? options.backoffMultiplier
            : base.backoffMultiplier)
        : base.backoffMultiplier,
  };
}

/**
 * Execute `fn` with bounded retries scoped to a durable operation key.
 *
 * Behaviour:
 * - Every attempt is logged with the same operation key and correlation IDs.
 * - `transient` failures are retried up to `maxAttempts`.
 * - `ambiguous` failures are never retried until `reconcileAmbiguous` confirms
 *   it is safe; otherwise an `AmbiguousOperationError` is thrown so the caller
 *   can leave the operation pending.
 * - `permanent` failures are thrown immediately.
 * - Retries are bounded; exhaustion throws `OperationRetryExhaustedError`.
 */
export async function retryOperation<T>(
  fn: (attempt: number) => Promise<T>,
  options: OperationRetryOptions
): Promise<T> {
  const config = normalizeOptions(options);
  const logger = options.logger ?? console;
  const classify = options.classifyError ?? (() => 'transient' as RetryFailureClass);
  const correlation: RetryCorrelationContext = {
    ...options.correlation,
    operationKey: options.operationKey,
  };
  const prefix = formatCorrelation(correlation);

  let attempt = 0;
  let lastError: unknown;

  while (attempt < config.maxAttempts) {
    attempt++;
    logger.log(`${prefix}operation attempt ${attempt}/${config.maxAttempts}`);

    try {
      const result = await fn(attempt);
      if (attempt > 1) {
        logger.log(`${prefix}operation succeeded on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      const failureClass = classify(error);
      const message = error instanceof Error ? error.message : String(error);

      if (failureClass === 'permanent') {
        logger.error(`${prefix}operation failed permanently: ${message}`);
        throw error;
      }

      if (failureClass === 'ambiguous') {
        logger.warn(`${prefix}operation outcome ambiguous: ${message}`);
        if (!options.reconcileAmbiguous) {
          throw new AmbiguousOperationError(
            `Ambiguous outcome for operation ${options.operationKey}; reconciliation required`,
            options.operationKey,
            error
          );
        }
        let safeToRetry = false;
        try {
          safeToRetry = await options.reconcileAmbiguous(error);
        } catch (reconcileError) {
          logger.error(
            `${prefix}reconciliation failed: ${
              reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
            }`
          );
        }
        if (!safeToRetry) {
          throw new AmbiguousOperationError(
            `Ambiguous outcome for operation ${options.operationKey}; reconciliation did not confirm retry safety`,
            options.operationKey,
            error
          );
        }
        logger.log(`${prefix}reconciliation confirmed retry is safe`);
      } else {
        logger.warn(`${prefix}operation transient failure: ${message}`);
      }

      if (attempt >= config.maxAttempts) {
        logger.error(
          `${prefix}operation exhausted ${config.maxAttempts} attempts`
        );
        throw new OperationRetryExhaustedError(
          `Operation ${options.operationKey} failed after ${config.maxAttempts} attempts`,
          options.operationKey,
          attempt,
          lastError
        );
      }

      const delay = calculateNextDelay(attempt - 1, config);
      logger.log(`${prefix}retrying in ${delay}ms`);
      await sleep(delay);
    }
  }

  // Unreachable in practice (loop always returns or throws), but keeps the
  // type checker satisfied.
  throw new OperationRetryExhaustedError(
    `Operation ${options.operationKey} failed`,
    options.operationKey,
    attempt,
    lastError
  );
}

export async function retryDependencyConnections(
  options: RetryOptions = {}
): Promise<void> {
  const config: Required<RetryOptions> = normalizeOptions(options);
  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt++;
    console.log(
      `[Startup] Checking dependencies (attempt ${attempt}/${config.maxAttempts})...`
    );

    try {
      const supabaseOk = await probeSupabase();
      const redisOk = await probeRedis();

      if (supabaseOk && redisOk) {
        console.log('[Startup] All dependencies are reachable ✓');
        return;
      }

      const failedDeps = [];
      if (!supabaseOk) failedDeps.push('Supabase');
      if (!redisOk) failedDeps.push('Redis');

      console.warn(`[Startup] Unreachable: ${failedDeps.join(', ')}`);
    } catch (error) {
      console.error(
        `[Startup] Dependency check failed:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    if (attempt >= config.maxAttempts) {
      console.error(
        `[Startup] Failed to connect to dependencies after ${config.maxAttempts} attempts. Exiting.`
      );
      process.exit(1);
    }

    const delay = calculateNextDelay(attempt - 1, config);
    console.log(`[Startup] Retrying in ${delay}ms...`);
    await sleep(delay);
  }
}
