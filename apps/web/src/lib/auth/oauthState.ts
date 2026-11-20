/**
 * OAuth `state` helpers for the (currently deferred) social-login flow.
 *
 * A state value is generated before redirecting to a provider, stored in
 * sessionStorage with an expiry, and consumed exactly once on callback. A
 * callback whose state is missing, expired, reused, or was never issued in
 * this browser session is rejected, which blocks CSRF-style login injection.
 *
 * Provider-specific code exchange happens on the backend. See
 * docs/social-login-roadmap.md for the allowed redirect URIs and account
 * linking policy.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const STORAGE_PREFIX = 'oauth:state:';

export type OAuthStateResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'unknown' };

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function issueOAuthState(provider: string, now: number = Date.now()): string {
  const state = randomState();
  const record = JSON.stringify({ provider, issuedAt: now });
  sessionStorage.setItem(`${STORAGE_PREFIX}${state}`, record);
  return state;
}

export function consumeOAuthState(
  state: string | null | undefined,
  provider: string,
  now: number = Date.now()
): OAuthStateResult {
  if (!state) return { ok: false, reason: 'missing' };
  const key = `${STORAGE_PREFIX}${state}`;
  const raw = sessionStorage.getItem(key);
  // Single use: remove before any validation so a replayed callback cannot succeed.
  sessionStorage.removeItem(key);
  if (!raw) return { ok: false, reason: 'unknown' };

  let record: { provider?: unknown; issuedAt?: unknown };
  try {
    record = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  if (record.provider !== provider || typeof record.issuedAt !== 'number') {
    return { ok: false, reason: 'unknown' };
  }
  if (now - record.issuedAt > OAUTH_STATE_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
}
