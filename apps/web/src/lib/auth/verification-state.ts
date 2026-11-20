/**
 * UI states for the email-verification landing page.
 */
export type VerifyState =
  | { kind: 'missing' }
  | { kind: 'verifying' }
  | { kind: 'verified' }
  | { kind: 'expired' }
  | { kind: 'invalid' }
  | { kind: 'error' };

/**
 * Maps a backend verify-email response to a UI state.
 * Expired, invalid and already-used links share a recovery path (request a
 * new link), so the page does not reveal more than necessary.
 */
export function classifyVerifyResponse(status: number, code?: string): VerifyState {
  if (status >= 200 && status < 300) return { kind: 'verified' };
  if (code === 'TOKEN_EXPIRED') return { kind: 'expired' };
  if (status === 400 || status === 401 || status === 404 || status === 409) return { kind: 'invalid' };
  return { kind: 'error' };
}
