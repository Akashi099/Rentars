import { beforeEach, describe, expect, it } from 'vitest';
import { OAUTH_STATE_TTL_MS, consumeOAuthState, issueOAuthState } from '../oauthState';

describe('oauth state', () => {
  beforeEach(() => sessionStorage.clear());

  it('accepts a state issued for the same provider exactly once', () => {
    const state = issueOAuthState('google', 1_000);
    expect(consumeOAuthState(state, 'google', 2_000)).toEqual({ ok: true });
    expect(consumeOAuthState(state, 'google', 2_001)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a missing state', () => {
    expect(consumeOAuthState(null, 'google')).toEqual({ ok: false, reason: 'missing' });
    expect(consumeOAuthState('', 'google')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a state that was never issued in this browser session', () => {
    expect(consumeOAuthState('forged-state', 'google')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a state issued for a different provider', () => {
    const state = issueOAuthState('google', 1_000);
    expect(consumeOAuthState(state, 'github', 2_000)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects and discards an expired state', () => {
    const state = issueOAuthState('github', 1_000);
    expect(consumeOAuthState(state, 'github', 1_000 + OAUTH_STATE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(sessionStorage.length).toBe(0);
  });

  it('generates unguessable, distinct values', () => {
    const a = issueOAuthState('google');
    const b = issueOAuthState('google');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
