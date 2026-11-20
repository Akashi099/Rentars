import { describe, expect, it } from 'vitest';
import { DEFAULT_POST_AUTH_PATH, sanitizeReturnPath } from '../safeReturnPath';

describe('sanitizeReturnPath', () => {
  it.each(['/dashboard', '/properties/123?tab=bookings', '/a/b#c'])('keeps in-app path %s', (p) => {
    expect(sanitizeReturnPath(p)).toBe(p);
  });

  it.each([
    'https://evil.test/steal',
    'http://evil.test',
    '//evil.test/path',
    '/\\evil.test',
    'javascript:alert(1)',
    'dashboard',
    '',
    '/path\nwith-newline',
    '/tab\tchar',
    ' /leading-space',
    `/${'a'.repeat(600)}`,
  ])('rejects unsafe value %j', (p) => {
    expect(sanitizeReturnPath(p)).toBe(DEFAULT_POST_AUTH_PATH);
  });

  it('falls back for null, undefined and non-strings', () => {
    expect(sanitizeReturnPath(null)).toBe(DEFAULT_POST_AUTH_PATH);
    expect(sanitizeReturnPath(undefined, '/home')).toBe('/home');
  });
});
