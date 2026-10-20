import { supabase } from '../config/supabase.js';
import { connectRedis } from '../config/redis.js';

interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
}

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

// ─── Payment attempt limits & provider circuit breakers (issue #774) ──────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. */
  failureThreshold?: number;
  /** Consecutive successes in half-open state required to close the circuit. */
  successThreshold?: number;
  /** How long the circuit stays open before allowing a half-open probe. */
  openDurationMs?: number;
}

export interface CircuitSnapshot {
  provider: string;
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  nextProbeAt: number | null;
  lastError: string | null;
}

const FALLBACK_CIRCUIT_FAILURE_THRESHOLD = 5;
const FALLBACK_CIRCUIT_SUCCESS_THRESHOLD = 2;
const FALLBACK_CIRCUIT_OPEN_DURATION_MS = 30000;

const DEFAULT_CIRCUIT_OPTIONS: Required<CircuitBreakerOptions> = {
  failureThreshold: parsePositiveInt(
    process.env.PAYMENT_CIRCUIT_FAILURE_THRESHOLD,
    FALLBACK_CIRCUIT_FAILURE_THRESHOLD
  ),
  successThreshold: parsePositiveInt(
    process.env.PAYMENT_CIRCUIT_SUCCESS_THRESHOLD,
    FALLBACK_CIRCUIT_SUCCESS_THRESHOLD
  ),
  openDurationMs: parseNonNegativeInt(
    process.env.PAYMENT_CIRCUIT_OPEN_DURATION_MS,
    FALLBACK_CIRCUIT_OPEN_DURATION_MS
  ),
};

interface CircuitEntry {
  state: CircuitState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  openedAt: number | null;
  lastError: string | null;
  options: Required<CircuitBreakerOptions>;
}

const circuitRegistry = new Map<string, CircuitEntry>();

function getCircuitEntry(provider: string): CircuitEntry {
  let entry = circuitRegistry.get(provider);
  if (!entry) {
    entry = {
      state: 'closed',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      openedAt: null,
      lastError: null,
      options: { ...DEFAULT_CIRCUIT_OPTIONS },
    };
    circuitRegistry.set(provider, entry);
  }
  return entry;
}

/**
 * Inspect the current circuit state for a provider without mutating it.
 * Transitions from `open` to `half-open` are evaluated lazily so operators
 * always see a truthful state.
 */
export function getCircuitState(provider: string): CircuitSnapshot {
  const entry = getCircuitEntry(provider);
  const now = Date.now();
  if (entry.state === 'open' && entry.openedAt !== null) {
    const elapsed = now - entry.openedAt;
    if (elapsed >= entry.options.openDurationMs) {
      entry.state = 'half-open';
      entry.consecutiveSuccesses = 0;
    }
  }
  return {
    provider,
    state: entry.state,
    consecutiveFailures: entry.consecutiveFailures,
    consecutiveSuccesses: entry.consecutiveSuccesses,
    openedAt: entry.openedAt,
    nextProbeAt:
      entry.state === 'open' && entry.openedAt !== null
        ? entry.openedAt + entry.options.openDurationMs
        : null,
    lastError: entry.lastError,
  };
}

/** Snapshot every tracked provider circuit (for operator inspection). */
export function listCircuitStates(): CircuitSnapshot[] {
  return Array.from(circuitRegistry.keys()).map((provider) => getCircuitState(provider));
}

export interface CircuitOpenError extends Error {
  code: 'CIRCUIT_OPEN';
  provider: string;
  retryAfterMs: number;
}

function makeCircuitOpenError(provider: string, retryAfterMs: number): CircuitOpenError {
  const err = new Error(
    `Provider "${provider}" is temporarily unavailable. Retry after ${retryAfterMs}ms.`
  ) as CircuitOpenError;
  err.code = 'CIRCUIT_OPEN';
  err.provider = provider;
  err.retryAfterMs = retryAfterMs;
  return err;
}

/**
 * Execute a provider call guarded by a circuit breaker.
 *
 * - `closed`: calls pass through; failures increment the counter.
 * - `open`: calls are rejected immediately with retry guidance (no provider
 *   request is made).  In-flight calls that already started are unaffected and
 *   continue their own reconciliation.
 * - `half-open`: a single probe is allowed; success closes the circuit,
 *   failure re-opens it.
 */
export async function withCircuitBreaker<T>(
  provider: string,
  fn: () => Promise<T>,
  options: CircuitBreakerOptions = {}
): Promise<T> {
  const entry = getCircuitEntry(provider);
  entry.options = {
    failureThreshold:
      options.failureThreshold !== undefined && Number.isFinite(options.failureThreshold) && options.failureThreshold >= 1
        ? Math.floor(options.failureThreshold)
        : entry.options.failureThreshold,
    successThreshold:
      options.successThreshold !== undefined && Number.isFinite(options.successThreshold) && options.successThreshold >= 1
        ? Math.floor(options.successThreshold)
        : entry.options.successThreshold,
    openDurationMs:
      options.openDurationMs !== undefined && Number.isFinite(options.openDurationMs) && options.openDurationMs >= 0
        ? Math.floor(options.openDurationMs)
        : entry.options.openDurationMs,
  };

  const snapshot = getCircuitState(provider);
  if (snapshot.state === 'open') {
    const retryAfterMs = snapshot.nextProbeAt !== null ? Math.max(0, snapshot.nextProbeAt - Date.now()) : entry.options.openDurationMs;
    throw makeCircuitOpenError(provider, retryAfterMs);
  }

  try {
    const result = await fn();
    entry.consecutiveFailures = 0;
    entry.lastError = null;
    if (entry.state === 'half-open') {
      entry.consecutiveSuccesses += 1;
      if (entry.consecutiveSuccesses >= entry.options.successThreshold) {
        entry.state = 'closed';
        entry.consecutiveSuccesses = 0;
        entry.openedAt = null;
      }
    }
    return result;
  } catch (error) {
    entry.consecutiveFailures += 1;
    entry.consecutiveSuccesses = 0;
    entry.lastError = error instanceof Error ? error.message : String(error);
    if (entry.state === 'half-open' || entry.consecutiveFailures >= entry.options.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = Date.now();
    }
    throw error;
  }
}

/**
 * Manually reset a provider circuit.  Callers must enforce operator
 * authorization and record an audit trail before invoking this.
 */
export function resetCircuit(provider: string): CircuitSnapshot {
  const entry = getCircuitEntry(provider);
  entry.state = 'closed';
  entry.consecutiveFailures = 0;
  entry.consecutiveSuccesses = 0;
  entry.openedAt = null;
  entry.lastError = null;
  return getCircuitState(provider);
}

// ─── Payment attempt limits ───────────────────────────────────────────────────

const FALLBACK_MAX_ATTEMPTS_PER_KEY = 3;
const FALLBACK_MAX_ATTEMPTS_PER_BOOKING = 5;

const MAX_ATTEMPTS_PER_KEY = parsePositiveInt(
  process.env.PAYMENT_MAX_ATTEMPTS_PER_KEY,
  FALLBACK_MAX_ATTEMPTS_PER_KEY
);
const MAX_ATTEMPTS_PER_BOOKING = parsePositiveInt(
  process.env.PAYMENT_MAX_ATTEMPTS_PER_BOOKING,
  FALLBACK_MAX_ATTEMPTS_PER_BOOKING
);

interface AttemptRecord {
  count: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
}

const attemptsByIdempotencyKey = new Map<string, AttemptRecord>();
const attemptsByBooking = new Map<string, AttemptRecord>();

export type AttemptDecision =
  | { allowed: true; attemptsForKey: number; attemptsForBooking: number }
  | {
      allowed: false;
      reason: 'idempotency-key-limit' | 'booking-limit';
      retryAfterMs: number;
      message: string;
    };

function recordAttempt(map: Map<string, AttemptRecord>, key: string): AttemptRecord {
  const now = Date.now();
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAttemptAt = now;
    return existing;
  }
  const record: AttemptRecord = { count: 1, firstAttemptAt: now, lastAttemptAt: now };
  map.set(key, record);
  return record;
}

/**
 * Check whether a new payment attempt is permitted for the given idempotency
 * key and booking.  When allowed, the attempt is recorded.  When rejected, a
 * truthful response with retry guidance is returned and no provider call
 * should be made.
 */
export function checkPaymentAttemptLimit(
  idempotencyKey: string,
  bookingId: string
): AttemptDecision {
  const keyRecord = attemptsByIdempotencyKey.get(idempotencyKey);
  const bookingRecord = attemptsByBooking.get(bookingId);

  if (keyRecord && keyRecord.count >= MAX_ATTEMPTS_PER_KEY) {
    return {
      allowed: false,
      reason: 'idempotency-key-limit',
      retryAfterMs: DEFAULT_CIRCUIT_OPTIONS.openDurationMs,
      message:
        'Too many payment attempts for this request. Please wait before retrying; ' +
        'existing transactions continue to be reconciled.',
    };
  }

  if (bookingRecord && bookingRecord.count >= MAX_ATTEMPTS_PER_BOOKING) {
    return {
      allowed: false,
      reason: 'booking-limit',
      retryAfterMs: DEFAULT_CIRCUIT_OPTIONS.openDurationMs,
      message:
        'Too many payment attempts for this booking. Please wait before retrying; ' +
        'existing transactions continue to be reconciled.',
    };
  }

  const updatedKey = recordAttempt(attemptsByIdempotencyKey, idempotencyKey);
  const updatedBooking = recordAttempt(attemptsByBooking, bookingId);

  return {
    allowed: true,
    attemptsForKey: updatedKey.count,
    attemptsForBooking: updatedBooking.count,
  };
}

/** Clear attempt counters (used after successful payment or by operators). */
export function clearPaymentAttempts(idempotencyKey?: string, bookingId?: string): void {
  if (idempotencyKey) attemptsByIdempotencyKey.delete(idempotencyKey);
  if (bookingId) attemptsByBooking.delete(bookingId);
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
