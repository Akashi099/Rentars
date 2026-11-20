import { describe, expect, it } from 'vitest';
import { getPasswordPolicyErrors } from '../password-policy';

describe('getPasswordPolicyErrors', () => {
  it('accepts a password that meets every rule', () => {
    expect(getPasswordPolicyErrors('Correct-Horse-42')).toEqual([]);
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(getPasswordPolicyErrors('Short-1a')).toContain('Password must be at least 12 characters.');
  });

  it('reports each missing character class', () => {
    const errors = getPasswordPolicyErrors('alllowercase12');
    expect(errors).toContain('Password must contain an uppercase letter.');
    expect(errors).toContain('Password must contain a special character.');
    expect(errors).not.toContain('Password must contain a number.');
  });

  it('rejects passwords longer than 128 characters', () => {
    expect(getPasswordPolicyErrors(`Aa1!${'x'.repeat(130)}`)).toContain('Password must be at most 128 characters.');
  });
});
