/**
 * Session revocation markers.
 *
 * Access tokens are stateless JWTs, so revoking a user's sessions (password
 * reset, "log out all devices") cannot remove tokens that were already issued.
 * Instead we record, per user, the point in time before which tokens are no
 * longer accepted. The session revocation guard compares each token's `iat`
 * against this marker.
 *
 * Key format:
 *   session:revoked-before:<userId> → unix seconds
 *
 * TTL covers the longest-lived token (8 days > 7 day wallet/refresh lifetime),
 * so markers expire only after every token they could affect has expired.
 *
 * Precision: `iat` has one-second resolution, so a token issued in the same
 * second as the revocation is still accepted. This window is at most one second.
 */

import { redisClient } from '@/config/redis.js';

const KEY_PREFIX = 'session:revoked-before:';
const MARKER_TTL_SECONDS = 60 * 60 * 24 * 8;

function markerKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/**
 * Reject every access token for `userId` issued before `at`.
 * Throws if Redis is unavailable so callers can fail the revocation loudly.
 */
export async function markUserSessionsRevoked(
  userId: string,
  at: Date = new Date()
): Promise<void> {
  const revokedBeforeSeconds = Math.floor(at.getTime() / 1000);
  await redisClient.set(markerKey(userId), String(revokedBeforeSeconds), {
    EX: MARKER_TTL_SECONDS,
  });
}

/**
 * Returns the unix-seconds cutoff for `userId`, or null when no revocation is active.
 * Throws if Redis is unavailable — callers must treat that as "unknown", not "valid".
 */
export async function getSessionRevokedBefore(userId: string): Promise<number | null> {
  const stored = await redisClient.get(markerKey(userId));
  if (!stored) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? parsed : null;
}
