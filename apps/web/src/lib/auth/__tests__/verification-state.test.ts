import { describe, expect, it } from 'vitest';
import { classifyVerifyResponse } from '../verification-state';

describe('classifyVerifyResponse', () => {
  it('reports verified for a 2xx response', () => {
    expect(classifyVerifyResponse(200)).toEqual({ kind: 'verified' });
  });

  it('reports expired when the backend returns TOKEN_EXPIRED', () => {
    expect(classifyVerifyResponse(401, 'TOKEN_EXPIRED')).toEqual({ kind: 'expired' });
  });

  it('reports invalid for replayed or unknown links', () => {
    expect(classifyVerifyResponse(401, 'INVALID_TOKEN')).toEqual({ kind: 'invalid' });
    expect(classifyVerifyResponse(400, 'INVALID_CREDENTIALS')).toEqual({ kind: 'invalid' });
  });

  it('reports a generic error for server failures', () => {
    expect(classifyVerifyResponse(500)).toEqual({ kind: 'error' });
  });
});
