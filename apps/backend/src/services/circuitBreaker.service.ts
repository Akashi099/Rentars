/**
 * Circuit Breaker Service — provider-level failure protection for payment
 * infrastructure (Stellar Horizon, Trustless Work, etc.).
 *
 * State machine:
 *
 *   ┌────────┐   >= failureThreshold failures in rollingWindowMs
 *   │ CLOSED │ ─────────────────────────────────────────────────► ┌──────┐
 *   │        │ ◄──────────────────────────────────────────────────│ OPEN │
 *   └────────┘   manual reset OR success in HALF_OPEN state       └──┬───┘
 *        ▲                                                            │
 *        │                      after openDurationMs                 │
 *        │            ┌────────────────────────────────────────────► │
 *        │            │                                               ▼
 *        │            │                                         ┌───────────┐
 *        └────────────┴─── success probe ◄─────────────────────│ HALF_OPEN │
 *                                                               └───────────┘
 *
 * IMPORTANT: The circuit breaker guards only NEW transaction submissions.
 * In-flight confirmTransaction() polling must never be blocked and must
 * not call checkCircuit() — only submitPayment/retryPayment do.
 *
 * Redis keys:
 *   circuit:{provider}:state      → 'CLOSED' | 'OPEN' | 'HALF_OPEN'
 *   circuit:{provider}:failures   → sorted set, member=timestamp, score=timestamp
 *   circuit:{provider}:opened_at  → epoch ms string
 *   circuit:{provider}:half_open_count → counter for concurrent HALF_OPEN probes
 */

import { redisClient } from '@/config/redis.js';
import { auditLogger } from './auditLogger.service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const KNOWN_PROVIDERS = ['stellar_horizon', 'trustless_work'] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number] | string;

interface ProviderConfig {
  failureThreshold: number;
  rollingWindowMs: number;
  openDurationMs: number;
  halfOpenMaxRequests: number;
}

const DEFAULT_CONFIG: ProviderConfig = {
  failureThreshold: 5,
  rollingWindowMs: 60_000,
  openDurationMs: 30_000,
  halfOpenMaxRequests: 1,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitStatusInfo {
  provider: string;
  state: CircuitState;
  failureCount: number;
  openedAt: number | null;
  /** Milliseconds until the circuit transitions from OPEN → HALF_OPEN. */
  msUntilHalfOpen: number | null;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class PaymentCircuitOpenError extends Error {
  readonly code = 'PAYMENT_CIRCUIT_OPEN';
  readonly retryAfterMs: number;

  constructor(provider: string, retryAfterMs: number) {
    super(
      `Payment provider '${provider}' circuit is OPEN. ` +
        `Retry after ${Math.ceil(retryAfterMs / 1000)} seconds.`,
    );
    this.name = 'PaymentCircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

function stateKey(provider: string): string {
  return `circuit:${provider}:state`;
}

function failuresKey(provider: string): string {
  return `circuit:${provider}:failures`;
}

function openedAtKey(provider: string): string {
  return `circuit:${provider}:opened_at`;
}

function halfOpenCountKey(provider: string): string {
  return `circuit:${provider}:half_open_count`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolve the effective configuration for the given provider.
 * Future work: allow per-provider overrides via environment variables.
 */
function getConfig(_provider: string): ProviderConfig {
  return DEFAULT_CONFIG;
}

/**
 * Read the current raw state stored in Redis, without any transition logic.
 * Returns 'CLOSED' when no state key exists (default).
 */
async function readStoredState(provider: string): Promise<CircuitState> {
  const stored = await redisClient.get(stateKey(provider));
  if (stored === 'OPEN' || stored === 'HALF_OPEN') return stored;
  return 'CLOSED';
}

/**
 * Count failures recorded within the rolling window.
 */
async function countRecentFailures(provider: string, rollingWindowMs: number): Promise<number> {
  const now = Date.now();
  const windowStart = now - rollingWindowMs;

  // Remove stale members before counting
  await redisClient.zRemRangeByScore(failuresKey(provider), '-inf', windowStart.toString());
  const count = await redisClient.zCard(failuresKey(provider));
  return count;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check the circuit state for `provider` and throw PaymentCircuitOpenError
 * if the circuit is OPEN.
 *
 * CLOSED     → proceeds normally, returns 'CLOSED'.
 * HALF_OPEN  → allows up to halfOpenMaxRequests probes, returns 'HALF_OPEN'.
 * OPEN       → evaluates whether openDurationMs has elapsed:
 *                - elapsed → transition to HALF_OPEN, allow one probe
 *                - not elapsed → throw PaymentCircuitOpenError
 *
 * Must only be called for NEW submissions, never for in-flight polling.
 */
export async function checkCircuit(provider: string): Promise<CircuitState> {
  const config = getConfig(provider);
  const storedState = await readStoredState(provider);

  if (storedState === 'CLOSED') {
    return 'CLOSED';
  }

  if (storedState === 'OPEN') {
    const openedAtStr = await redisClient.get(openedAtKey(provider));
    const openedAt = openedAtStr ? parseInt(openedAtStr, 10) : 0;
    const elapsed = Date.now() - openedAt;

    if (elapsed >= config.openDurationMs) {
      // Transition to HALF_OPEN to allow a probe
      await redisClient.set(stateKey(provider), 'HALF_OPEN');
      await redisClient.set(halfOpenCountKey(provider), '0', { EX: Math.ceil(config.openDurationMs / 1000) });
      return 'HALF_OPEN';
    }

    // Still OPEN — reject the call
    const retryAfterMs = config.openDurationMs - elapsed;
    throw new PaymentCircuitOpenError(provider, retryAfterMs);
  }

  // HALF_OPEN — check if we still have capacity for probe requests
  if (storedState === 'HALF_OPEN') {
    const countStr = await redisClient.get(halfOpenCountKey(provider));
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= config.halfOpenMaxRequests) {
      // Slot taken; treat as OPEN until the probe resolves
      throw new PaymentCircuitOpenError(provider, config.openDurationMs);
    }

    // Consume one HALF_OPEN slot
    await redisClient.incr(halfOpenCountKey(provider));
    return 'HALF_OPEN';
  }

  return storedState;
}

/**
 * Record a successful provider call.
 *
 * - In HALF_OPEN: transitions circuit back to CLOSED and clears failures.
 * - In CLOSED: no state change (failures are not cleared on success here,
 *   only the window expiry clears them to preserve accurate sliding counts).
 */
export async function recordSuccess(provider: string): Promise<void> {
  const storedState = await readStoredState(provider);

  if (storedState === 'HALF_OPEN') {
    // Probe succeeded — close the circuit
    await redisClient.set(stateKey(provider), 'CLOSED');
    await redisClient.del(openedAtKey(provider));
    await redisClient.del(halfOpenCountKey(provider));
    await redisClient.del(failuresKey(provider));

    console.info(`[CircuitBreaker] ${provider} circuit CLOSED after successful probe`);
  }
  // CLOSED: nothing to do — failures are removed by the sliding window TTL
}

/**
 * Record a failed provider call.
 *
 * - Adds a timestamped entry to the sliding-window failure set.
 * - If failures in the current window reach failureThreshold, opens the circuit.
 * - In HALF_OPEN: an immediate failure re-opens the circuit.
 */
export async function recordFailure(provider: string): Promise<void> {
  const config = getConfig(provider);
  const now = Date.now();

  // Add failure to sorted set; use timestamp as both member and score for
  // easy range queries. Expire the whole key after two rolling windows to
  // prevent unbounded growth.
  const key = failuresKey(provider);
  await redisClient.zAdd(key, { score: now, value: now.toString() });
  await redisClient.expire(key, Math.ceil((config.rollingWindowMs * 2) / 1000));

  const storedState = await readStoredState(provider);

  if (storedState === 'HALF_OPEN') {
    // Probe failed — re-open immediately
    await redisClient.set(stateKey(provider), 'OPEN');
    await redisClient.set(openedAtKey(provider), now.toString());
    await redisClient.del(halfOpenCountKey(provider));
    console.warn(`[CircuitBreaker] ${provider} circuit re-OPENED after failed probe`);
    return;
  }

  // CLOSED: check whether the threshold has been crossed
  const recentFailures = await countRecentFailures(provider, config.rollingWindowMs);

  if (recentFailures >= config.failureThreshold) {
    await redisClient.set(stateKey(provider), 'OPEN');
    await redisClient.set(openedAtKey(provider), now.toString());

    console.warn(
      `[CircuitBreaker] ${provider} circuit OPENED ` +
        `(${recentFailures} failures in ${config.rollingWindowMs}ms)`,
    );
  }
}

/**
 * Return a snapshot of the circuit state for operator inspection.
 * Safe to call at any frequency — no state mutations.
 */
export async function getCircuitStatus(provider: string): Promise<CircuitStatusInfo> {
  const config = getConfig(provider);
  const storedState = await readStoredState(provider);
  const failureCount = await countRecentFailures(provider, config.rollingWindowMs);

  const openedAtStr = await redisClient.get(openedAtKey(provider));
  const openedAt = openedAtStr ? parseInt(openedAtStr, 10) : null;

  let msUntilHalfOpen: number | null = null;
  if (storedState === 'OPEN' && openedAt !== null) {
    const elapsed = Date.now() - openedAt;
    msUntilHalfOpen = Math.max(0, config.openDurationMs - elapsed);
  }

  return {
    provider,
    state: storedState,
    failureCount,
    openedAt,
    msUntilHalfOpen,
  };
}

/**
 * Manually reset a circuit breaker to CLOSED state.
 * Clears all failure history and writes an audit log entry.
 *
 * Should only be called by authenticated operators via the admin API.
 *
 * @param provider  - Provider identifier (e.g. 'stellar_horizon').
 * @param actorId   - Admin user ID performing the reset (for audit trail).
 * @param reason    - Human-readable reason for the manual reset.
 */
export async function resetCircuit(
  provider: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const statusBefore = await getCircuitStatus(provider);

  // Clear all circuit state
  await redisClient.del(stateKey(provider));
  await redisClient.del(failuresKey(provider));
  await redisClient.del(openedAtKey(provider));
  await redisClient.del(halfOpenCountKey(provider));

  console.info(
    `[CircuitBreaker] ${provider} circuit manually RESET by actor=${actorId} reason="${reason}"`,
  );

  await auditLogger.log({
    actorId,
    action: 'admin.settings_change',
    resourceType: 'admin',
    resourceId: provider,
    success: true,
    meta: {
      operation: 'circuit_breaker_reset',
      provider,
      reason,
      stateBefore: statusBefore.state,
      failureCountBefore: statusBefore.failureCount,
      openedAtBefore: statusBefore.openedAt,
    },
  });
}
