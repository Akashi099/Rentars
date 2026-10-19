import { describe, expect, it } from 'bun:test';
import { sanitizeAuditMeta } from '../../src/services/auditLogger.service.js';

describe('sanitizeAuditMeta', () => {
  it('redacts credentials, key material and raw payloads by key name', () => {
    const out = sanitizeAuditMeta({
      password: 'hunter2',
      refresh_token: 'abc',
      secretSeed: 'S...',
      rawProviderResponse: { body: 'provider says hi' },
      messageBody: 'private text',
      booking_id: 'b-1',
    });
    expect(out).toEqual({
      password: '[REDACTED]',
      refresh_token: '[REDACTED]',
      secretSeed: '[REDACTED]',
      rawProviderResponse: '[REDACTED]',
      messageBody: '[REDACTED]',
      booking_id: 'b-1',
    });
  });

  it('redacts sensitive keys nested inside arrays', () => {
    const out = sanitizeAuditMeta({
      attempts: [{ password: 'x', reason: 'late' }],
    });
    expect(out).toEqual({ attempts: [{ password: '[REDACTED]', reason: 'late' }] });
  });

  it('keeps arrays as arrays', () => {
    const out = sanitizeAuditMeta({ ids: ['a', 'b'] });
    expect(Array.isArray(out?.ids)).toBe(true);
    expect(out?.ids).toEqual(['a', 'b']);
  });

  it('truncates long strings', () => {
    const out = sanitizeAuditMeta({ reason: 'x'.repeat(300) });
    expect(String(out?.reason).endsWith('...[TRUNCATED]')).toBe(true);
  });

  it('returns undefined for missing metadata', () => {
    expect(sanitizeAuditMeta(undefined)).toBeUndefined();
  });
});
