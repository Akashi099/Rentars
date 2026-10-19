/**
 * Payment Attempt Limiter Service — per-booking and per-actor rate limiting
 * for payment submissions to prevent abuse and runaway retry loops.
 *
 * Limits (sliding 1-hour window):
 *   Per booking:  5 attempts across any actor
 *   Per actor:   10 attempts across any booking
 *
 * Redis keys:
 *   payment_attempts:booking:{bookingId} → integer counter, TTL 3600 s
 *   payment_attempts:actor:{tenantId}    → integer counter, TTL 3600 s
 *
 * Both keys use a simple INCR + EXPIRE pattern.  The TTL slides on every
 * increment via EXPIRE so that the window is "at most 1 hour since the first
 * attempt in the current window", which is a standard token-bucket
 * approximation sufficient for abuse prevention.
 *
 * For operator use, resetAttempts() deletes both keys and writes an audit
 * log entry so every manual reset is traceable.
 */

import { redisClient } from '@/config/redis.js';
import { auditLogger } from './auditLogger.service.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const BOOKING_MAX_ATTEMPTS = 5;
const ACTOR_MAX_ATTEMPTS = 10;
const WINDOW_SECONDS = 3600; // 1 hour

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AttemptCheckResult {
  /** Whether the attempt is permitted. */
  allowed: boolean;
  /** Current booking attempt count (after this increment if allowed). */
  bookingAttempts: number;
  /** Current actor attempt count (after this increment if allowed). */
  actorAttempts: number;
  /**
   * When allowed=false, approximate seconds until the window resets.
   * Derived from the TTL of the exhausted key.
   */
  retryAfterSeconds?: number;
}

export interface AttemptCounts {
  bookingAttempts: number;
  actorAttempts: number;
}

// ─── Redis key helpers ────────────────────────────────────────────────────────

function bookingKey(bookingId: string): string {
  return `payment_attempts:booking:${bookingId}`;
}

function actorKey(tenantId: string): string {
  return `payment_attempts:actor:${tenantId}`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Atomically increment a Redis counter and set/refresh its TTL.
 * Returns the new counter value.
 */
async function incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
  const newCount = await redisClient.incr(key);
  if (newCount === 1) {
    // First increment — set the initial TTL
    await redisClient.expire(key, ttlSeconds);
  }
  return newCount;
}

/**
 * Read a counter without modifying it.  Returns 0 when the key does not exist.
 */
async function readCounter(key: string): Promise<number> {
  const raw = await redisClient.get(key);
  return raw ? parseInt(raw, 10) : 0;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether a payment attempt is permitted for the given booking and actor,
 * and increment both counters if it is.
 *
 * The check-then-increment is NOT transactional across both keys; we accept
 * the very small race window because the limits are soft guards against
 * accidental runaway rather than strict financial controls (which are enforced
 * downstream by idempotency keys and the payment state machine).
 *
 * Algorithm:
 *  1. Read both current counts.
 *  2. If either is at or above its limit, reject immediately (no increment).
 *  3. Otherwise increment both and return the new values.
 *
 * @returns AttemptCheckResult — allowed flag + current counts + retryAfterSeconds
 */
export async function checkAndIncrementAttempts(
  bookingId: string,
  tenantId: string,
): Promise<AttemptCheckResult> {
  const bKey = bookingKey(bookingId);
  const aKey = actorKey(tenantId);

  // Read current counts before incrementing
  const [currentBooking, currentActor] = await Promise.all([
    readCounter(bKey),
    readCounter(aKey),
  ]);

  // Check booking limit
  if (currentBooking >= BOOKING_MAX_ATTEMPTS) {
    const ttl = await redisClient.ttl(bKey);
    return {
      allowed: false,
      bookingAttempts: currentBooking,
      actorAttempts: currentActor,
      retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }

  // Check actor limit
  if (currentActor >= ACTOR_MAX_ATTEMPTS) {
    const ttl = await redisClient.ttl(aKey);
    return {
      allowed: false,
      bookingAttempts: currentBooking,
      actorAttempts: currentActor,
      retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }

  // Both limits have capacity — increment both
  const [newBooking, newActor] = await Promise.all([
    incrementWithTtl(bKey, WINDOW_SECONDS),
    incrementWithTtl(aKey, WINDOW_SECONDS),
  ]);

  return {
    allowed: true,
    bookingAttempts: newBooking,
    actorAttempts: newActor,
  };
}

/**
 * Return current attempt counts for a booking/actor pair without incrementing.
 * Intended for admin inspection endpoints.
 */
export async function getAttemptCounts(
  bookingId: string,
  tenantId: string,
): Promise<AttemptCounts> {
  const [bookingAttempts, actorAttempts] = await Promise.all([
    readCounter(bookingKey(bookingId)),
    readCounter(actorKey(tenantId)),
  ]);

  return { bookingAttempts, actorAttempts };
}

/**
 * Reset attempt counters for a specific booking and actor.
 * Deletes both Redis keys and writes an audit log entry.
 *
 * Should only be called by authenticated operators via the admin API.
 *
 * @param bookingId - Booking whose attempt counter is reset.
 * @param tenantId  - Tenant (actor) whose attempt counter is reset.
 * @param actorId   - Admin user ID performing the reset (for audit trail).
 * @param reason    - Human-readable reason for the reset.
 */
export async function resetAttempts(
  bookingId: string,
  tenantId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const countsBefore = await getAttemptCounts(bookingId, tenantId);

  await Promise.all([
    redisClient.del(bookingKey(bookingId)),
    redisClient.del(actorKey(tenantId)),
  ]);

  console.info(
    `[PaymentAttemptLimiter] Counters reset by actor=${actorId} ` +
      `bookingId=${bookingId} tenantId=${tenantId} reason="${reason}"`,
  );

  await auditLogger.log({
    actorId,
    action: 'admin.settings_change',
    resourceType: 'payment',
    resourceId: bookingId,
    success: true,
    meta: {
      operation: 'payment_attempt_reset',
      bookingId,
      tenantId,
      reason,
      bookingAttemptsBefore: countsBefore.bookingAttempts,
      actorAttemptsBefore: countsBefore.actorAttempts,
    },
  });
}
