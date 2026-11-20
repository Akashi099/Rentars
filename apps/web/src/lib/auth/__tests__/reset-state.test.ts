import { describe, expect, it } from 'vitest';
import { classifyResetResponse } from '../reset-state';

describe('classifyResetResponse', () => {
  it('reports success for a 2xx response', () => {
    expect(classifyResetResponse(200)).toEqual({ kind: 'success' });
  });

  it('treats expired, unknown and reused tokens the same way', () => {
    expect(classifyResetResponse(401, 'TOKEN_EXPIRED')).toEqual({ kind: 'invalid' });
    expect(classifyResetResponse(401, 'INVALID_TOKEN')).toEqual({ kind: 'invalid' });
  });

  it('asks the user to fix the password when validation fails', () => {
    expect(classifyResetResponse(400)).toEqual({
      kind: 'error',
      message: 'Please check the password requirements below.',
    });
  });

  it('shows a generic message for server errors', () => {
    expect(classifyResetResponse(500)).toEqual({
      kind: 'error',
      message: 'We could not reset your password. Please try again.',
    });
  });
});
