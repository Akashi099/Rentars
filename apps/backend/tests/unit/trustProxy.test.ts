import { describe, expect, it } from 'bun:test';
import { parseTrustProxy } from '../../src/utils/trustProxy.js';

describe('parseTrustProxy', () => {
  it('does not trust forwarding headers by default', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('accepts a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('accepts an explicit list of proxy addresses and subnets', () => {
    expect(parseTrustProxy('10.0.0.0/8, loopback')).toEqual(['10.0.0.0/8', 'loopback']);
  });

  it('rejects "true", which would trust any client-supplied X-Forwarded-For', () => {
    expect(() => parseTrustProxy('true')).toThrow(/not allowed/);
  });

  it('rejects a zero hop count', () => {
    expect(() => parseTrustProxy('0')).toThrow(/at least 1/);
  });
});
