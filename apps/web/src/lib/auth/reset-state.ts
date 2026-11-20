/**
 * Outcome states for the reset-password page.
 */
export type Outcome =
  | { kind: 'idle' }
  | { kind: 'success' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

/**
 * Maps a backend confirm response to an outcome. Expired, unknown and already-used
 * tokens share one recovery path, so the page does not reveal which case applied.
 */
export function classifyResetResponse(status: number, code?: string): Outcome {
  if (status >= 200 && status < 300) return { kind: 'success' };
  if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || status === 401) return { kind: 'invalid' };
  // Schema failures come back as 400 without a stable code, so any 400 here is
  // treated as a requirements problem with the submitted password.
  if (status === 400) {
    return { kind: 'error', message: 'Please check the password requirements below.' };
  }
  return { kind: 'error', message: 'We could not reset your password. Please try again.' };
}

