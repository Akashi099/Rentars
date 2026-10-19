/**
 * Unit tests for moderationPolicy.service.ts.
 *
 * Covers:
 *   - getCurrentModerationPolicy: DB-backed snapshot, fallback when DB unavailable
 *   - isValidReportReason: valid/invalid codes, new expanded taxonomy
 *   - getReasonMapping: returns correct action/severity per code
 *   - getActionForReason: default enforcement action per reason
 *   - getSupportedReasonCodes: returns all 10 reasons
 *   - getPolicyVersion: historical lookup, not-found case
 *   - listPolicyVersions: returns sorted versions
 *   - FALLBACK_REASON_CODES covers all required codes
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─── Supabase mock ────────────────────────────────────────────────────────────

function chain(result: unknown) {
  const node: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'order', 'single'];
  for (const m of methods) node[m] = mock(() => node);
  node['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

const mockFrom = mock((_: string) => chain({ data: null, error: null }));

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

import {
  getCurrentModerationPolicy,
  isValidReportReason,
  getReasonMapping,
  getActionForReason,
  getSupportedReasonCodes,
  getPolicyVersion,
  listPolicyVersions,
  FALLBACK_REASON_CODES,
} from '../../src/services/moderationPolicy.service.js';

// Reset in-memory cache between tests
async function resetCache() {
  // Re-import with a fresh module cache isn't possible in Bun's mock system,
  // so we trigger a DB fetch by making the next call see a stale cache.
  // We do this by directly patching the module's exported cache (if accessible)
  // or just verifying behaviour from a clean mock state.
  mockFrom.mockClear();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('FALLBACK_REASON_CODES', () => {
  it('contains all 10 required reason codes', () => {
    const required = [
      'spam', 'fraud', 'inappropriate', 'misleading', 'harassment',
      'discrimination', 'unsafe_property', 'privacy', 'retaliatory', 'other',
    ];
    for (const code of required) {
      expect(FALLBACK_REASON_CODES).toContain(code);
    }
    expect(FALLBACK_REASON_CODES).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getCurrentModerationPolicy', () => {
  beforeEach(resetCache);

  it('returns fallback snapshot when DB has no active policy', async () => {
    // DB returns no active version
    mockFrom.mockImplementation(() => chain({ data: null, error: { message: 'not found' } }));

    const result = await getCurrentModerationPolicy();
    expect(result.success).toBe(true);
    expect(result.data!.version).toBe('2026-10-16.1');
    expect(result.data!.reasons.length).toBeGreaterThan(0);
  });

  it('returns fallback snapshot when DB returns empty mappings', async () => {
    mockFrom
      .mockImplementationOnce(() =>
        chain({
          data: {
            id: 'v1', version: '2026-10-16.1', effective_date: '2026-10-16',
            summary: 'Test policy', policy_url: null,
            appeal_window_days: 14, retention_days: 365, is_active: true,
          },
          error: null,
        }),
      )
      .mockImplementation(() => chain({ data: null, error: { message: 'no mappings' } }));

    const result = await getCurrentModerationPolicy();
    expect(result.success).toBe(true);
    // Falls back to hardcoded policy
    expect(result.data!.reasons.length).toBeGreaterThan(0);
  });

  it('builds snapshot from DB version + mappings', async () => {
    const versionRow = {
      id: 'v1', version: '2026-10-16.1', effective_date: '2026-10-16',
      summary: 'Test policy', policy_url: 'https://rentars.app/policy',
      appeal_window_days: 14, retention_days: 365, is_active: true,
    };
    const mappings = [
      {
        id: 'm1', policy_version_id: 'v1', reason_code: 'spam',
        reason_label: 'Spam', reason_description: 'Spam description',
        default_action: 'review', notify_author: true, notify_reporter: true,
        severity: 'low', sort_order: 1,
      },
    ];

    mockFrom
      .mockImplementationOnce(() => chain({ data: versionRow, error: null }))
      .mockImplementation(() => chain({ data: mappings, error: null }));

    const result = await getCurrentModerationPolicy();
    expect(result.success).toBe(true);
    expect(result.data!.version).toBe('2026-10-16.1');
    expect(result.data!.reasons).toHaveLength(1);
    expect(result.data!.reasons[0].code).toBe('spam');
    expect(result.data!.appealWindowDays).toBe(14);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('isValidReportReason', () => {
  it('accepts all 10 fallback reason codes', async () => {
    for (const code of FALLBACK_REASON_CODES) {
      const valid = await isValidReportReason(code);
      expect(valid).toBe(true);
    }
  });

  it('rejects an unsupported reason code', async () => {
    const valid = await isValidReportReason('nonsense_reason');
    expect(valid).toBe(false);
  });

  it('rejects an empty string', async () => {
    const valid = await isValidReportReason('');
    expect(valid).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getReasonMapping', () => {
  it('returns the correct mapping for "fraud"', async () => {
    const mapping = await getReasonMapping('fraud');
    expect(mapping).not.toBeNull();
    expect(mapping!.reason_code).toBe('fraud');
    expect(mapping!.default_action).toBe('remove');
    expect(mapping!.severity).toBe('critical');
  });

  it('returns the correct mapping for "harassment"', async () => {
    const mapping = await getReasonMapping('harassment');
    expect(mapping).not.toBeNull();
    expect(mapping!.default_action).toBe('hide');
    expect(mapping!.severity).toBe('high');
  });

  it('returns the correct mapping for "spam" (low severity)', async () => {
    const mapping = await getReasonMapping('spam');
    expect(mapping).not.toBeNull();
    expect(mapping!.severity).toBe('low');
    expect(mapping!.default_action).toBe('review');
  });

  it('returns null for unknown reason code', async () => {
    const mapping = await getReasonMapping('unknown_code');
    expect(mapping).toBeNull();
  });

  // New expanded reasons
  it('returns critical severity for "discrimination"', async () => {
    const mapping = await getReasonMapping('discrimination');
    expect(mapping!.default_action).toBe('remove');
    expect(mapping!.severity).toBe('critical');
  });

  it('returns high severity for "unsafe_property"', async () => {
    const mapping = await getReasonMapping('unsafe_property');
    expect(mapping!.default_action).toBe('hide');
    expect(mapping!.severity).toBe('high');
  });

  it('returns critical severity for "privacy"', async () => {
    const mapping = await getReasonMapping('privacy');
    expect(mapping!.default_action).toBe('remove');
    expect(mapping!.severity).toBe('critical');
  });

  it('returns medium severity for "retaliatory"', async () => {
    const mapping = await getReasonMapping('retaliatory');
    expect(mapping!.default_action).toBe('review');
    expect(mapping!.severity).toBe('medium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getActionForReason', () => {
  it('returns "remove" for fraud', async () => {
    expect(await getActionForReason('fraud')).toBe('remove');
  });

  it('returns "hide" for inappropriate', async () => {
    expect(await getActionForReason('inappropriate')).toBe('hide');
  });

  it('returns "review" for spam', async () => {
    expect(await getActionForReason('spam')).toBe('review');
  });

  it('returns "review" (safe default) for unknown reason', async () => {
    expect(await getActionForReason('completely_unknown')).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getSupportedReasonCodes', () => {
  beforeEach(resetCache);

  it('returns all 10 reason codes when DB is unavailable', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: { message: 'down' } }));
    const codes = await getSupportedReasonCodes();
    expect(codes).toHaveLength(10);
    expect(codes).toContain('harassment');
    expect(codes).toContain('discrimination');
    expect(codes).toContain('retaliatory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getPolicyVersion', () => {
  beforeEach(resetCache);

  it('returns a policy snapshot for a known version', async () => {
    const versionRow = {
      id: 'v1', version: '2026-10-16.1', effective_date: '2026-10-16',
      summary: 'Historic policy', policy_url: null,
      appeal_window_days: 14, retention_days: 365, is_active: false,
    };
    mockFrom
      .mockImplementationOnce(() => chain({ data: versionRow, error: null }))
      .mockImplementation(() =>
        chain({ data: [{ id: 'm1', policy_version_id: 'v1', reason_code: 'spam',
          reason_label: 'Spam', reason_description: 'Spam', default_action: 'review',
          notify_author: true, notify_reporter: true, severity: 'low', sort_order: 1 }], error: null }),
      );

    const result = await getPolicyVersion('2026-10-16.1');
    expect(result.success).toBe(true);
    expect(result.data!.version).toBe('2026-10-16.1');
    expect(result.data!.reasons).toHaveLength(1);
  });

  it('returns error for unknown version', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'not found' } }),
    );
    const result = await getPolicyVersion('1990-01-01.0');
    expect(result.success).toBe(false);
    expect(result.error).toContain('1990-01-01.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('listPolicyVersions', () => {
  beforeEach(resetCache);

  it('returns all policy versions from DB', async () => {
    const versions = [
      { id: 'v2', version: '2027-01-01.1', is_active: true },
      { id: 'v1', version: '2026-10-16.1', is_active: false },
    ];
    mockFrom.mockImplementation(() => chain({ data: versions, error: null }));

    const result = await listPolicyVersions();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no versions exist', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await listPolicyVersions();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'timeout' } }),
    );
    const result = await listPolicyVersions();
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('taxonomy alignment — UI/API/moderator use same codes', () => {
  it('every FALLBACK_REASON_CODE has a non-null mapping with all required fields', async () => {
    for (const code of FALLBACK_REASON_CODES) {
      const mapping = await getReasonMapping(code);
      expect(mapping).not.toBeNull();
      expect(mapping!.reason_label).toBeTruthy();
      expect(mapping!.reason_description).toBeTruthy();
      expect(['review', 'hide', 'remove', 'warn', 'ban']).toContain(mapping!.default_action);
      expect(['low', 'medium', 'high', 'critical']).toContain(mapping!.severity);
    }
  });

  it('no two reason codes share the same sort_order', async () => {
    const orders = new Set<number>();
    for (const code of FALLBACK_REASON_CODES) {
      const mapping = await getReasonMapping(code);
      expect(orders.has(mapping!.sort_order)).toBe(false);
      orders.add(mapping!.sort_order);
    }
  });
});
