/**
 * Resolves the JWT signing secret without ever falling back to a hard-coded value.
 *
 * Kept separate from `env.ts` so modules can use it without triggering the
 * process-exiting env validation at import time (which unit tests rely on).
 *
 * Fails closed: a missing or short secret throws instead of signing with a
 * guessable key.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  return secret;
}
