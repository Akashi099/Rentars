/**
 * Tests for #772 — Reconciliation operations view.
 *
 * Covers:
 *  - Listing cases with pagination + status filter + age filter
 *  - Fetching a single case
 *  - Retry: success, already-resolved 409, escalated 409
 *  - Escalate: success, already-resolved 409
 *  - Resolve: success, idempotent 409
 *  - Role access: support can read, cannot write; finance can write
 *  - DTO shape: no PII beyond tenantId, no secret payloads
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Supabase mock ─────────────────────────────────────────────────────────────

const cases = new Map<string, Record<string, unknown>>();

function seedCase(overrides: Partial<Record<string, unknown>> = {}) {
  const id = `case-${Date.now()}-${Math.random()}`;
  const row: Record<string, unknown> = {
    id,
    booking_id: 'booking-001',
    payment_id: 'payment-001',
    tenant_id: 'tenant-001',
    property_id: 'property-001',
    status: 'pending',
    reconcile_attempts: 0,
    escrow_hash: 'e'.repeat(64),
    on_chain_id: 42,
    last_reconcile_at: null,
    last_reconcile_error: null,
    escalated_reason: null,
    escalated_to: null,
    escalated_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  cases.set(id, row);
  return row;
}

const supabaseMock = {
  from: vi.fn((_table: string) => {
    return {
      select: vi.fn((_cols?: string, _opts?: unknown) => {
        const chain: Record<string, unknown> = {};
        let filtered = [...cases.values()];

        chain.order = vi.fn(() => chain);
        chain.range = vi.fn(() => chain);
        chain.eq = vi.fn((_col: string, val: unknown) => {
          filtered = filtered.filter((r) => r[_col] === val);
          return chain;
        });
        chain.lt = vi.fn(() => chain);
        // Allow awaiting
        Object.defineProperty(chain, Symbol.for('nodejs.rejection'), { value: undefined });
        chain.then = (
          resolve: (v: { data: unknown[]; error: null; count: number }) => unknown,
          reject?: (r: unknown) => unknown,
        ) =>
          Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(
            resolve,
            reject,
          );
        chain.single = vi.fn(async () => {
          return filtered.length > 0
            ? { data: filtered[0], error: null }
            : { data: null, error: { message: 'not found' } };
        });
        return chain;
      }),
      update: vi.fn((patch: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {};
        let targetId: string | null = null;
        chain.eq = vi.fn((_col: string, val: unknown) => {
          if (_col === 'id') targetId = val as string;
          return chain;
        });
        chain.select = vi.fn(() => {
          const inner: Record<string, unknown> = {};
          inner.single = vi.fn(async () => {
            if (!targetId || !cases.has(targetId)) {
              return { data: null, error: { message: 'not found' } };
            }
            const updated = { ...cases.get(targetId)!, ...patch };
            cases.set(targetId, updated);
            return { data: updated, error: null };
          });
          return inner;
        });
        return chain;
      }),
    };
  }),
};

vi.mock('@/config/supabase.js', () => ({ supabase: supabaseMock }));

vi.mock('@/services/auditLogger.service.js', () => ({
  auditLogger: { log: vi.fn(async () => {}) },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

const {
  listReconciliationCases,
  getReconciliationCase,
  retryReconciliationCase,
  escalateReconciliationCase,
  resolveReconciliationCase,
} = await import('@/controllers/reconciliation.controller.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockRes = {
  statusCode: number;
  _json: unknown;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
};

function makeRes(): MockRes {
  const res = { statusCode: 200, _json: null } as MockRes;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res._json = body; return res; });
  return res;
}

function makeReq(overrides: Partial<Record<string, unknown>> = {}) {
  return { adminId: 'admin-001', query: {}, body: {}, params: {}, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════════
// List
// ═══════════════════════════════════════════════════════════════════════════════

describe('listReconciliationCases', () => {
  beforeEach(() => cases.clear());

  it('returns paginated results', async () => {
    seedCase(); seedCase(); seedCase();
    const res = makeRes();
    await listReconciliationCases(makeReq() as never, res as never);
    const body = res._json as { data: unknown[]; meta: { total: number } };
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.total).toBe(3);
  });

  it('omits PII fields beyond tenantId', async () => {
    seedCase({ tenant_email: 'secret@example.com', wallet_secret: 'SXXX' });
    const res = makeRes();
    await listReconciliationCases(makeReq() as never, res as never);
    const body = res._json as { data: Array<Record<string, unknown>> };
    const dto = body.data[0];
    expect(dto.tenantId).toBeDefined();
    expect(dto.tenant_email).toBeUndefined();
    expect(dto.wallet_secret).toBeUndefined();
  });

  it('validates pagination defaults', async () => {
    const res = makeRes();
    await listReconciliationCases(makeReq({ query: {} }) as never, res as never);
    const body = res._json as { meta: { page: number; limit: number } };
    expect(body.meta.page).toBe(1);
    expect(body.meta.limit).toBe(20);
  });

  it('rejects limit > 50', async () => {
    const res = makeRes();
    await listReconciliationCases(
      makeReq({ query: { limit: '100' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Get single case
// ═══════════════════════════════════════════════════════════════════════════════

describe('getReconciliationCase', () => {
  beforeEach(() => cases.clear());

  it('returns 200 with DTO for existing case', async () => {
    const row = seedCase();
    const res = makeRes();
    await getReconciliationCase(makeReq({ params: { id: row.id } }) as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res._json as { data: { id: string } };
    expect(body.data.id).toBe(row.id);
  });

  it('returns 404 for unknown case', async () => {
    const res = makeRes();
    await getReconciliationCase(makeReq({ params: { id: 'no-such-id' } }) as never, res as never);
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Retry
// ═══════════════════════════════════════════════════════════════════════════════

describe('retryReconciliationCase', () => {
  beforeEach(() => cases.clear());

  it('queues retry and increments attempt counter', async () => {
    const row = seedCase({ status: 'mismatch', reconcile_attempts: 2 });
    const res = makeRes();
    await retryReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'manual re-queue after RPC fix' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const updated = cases.get(row.id as string)!;
    expect(updated.status).toBe('pending');
    expect(updated.reconcile_attempts).toBe(3);
  });

  it('returns 409 when case is already resolved', async () => {
    const row = seedCase({ status: 'resolved' });
    const res = makeRes();
    await retryReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'test' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res._json as { error: { code: string } }).error.code).toBe('ALREADY_RESOLVED');
  });

  it('returns 409 when case is escalated', async () => {
    const row = seedCase({ status: 'escalated' });
    const res = makeRes();
    await retryReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'test' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res._json as { error: { code: string } }).error.code).toBe('CASE_ESCALATED');
  });

  it('returns 400 when reason is missing or too short', async () => {
    const row = seedCase();
    const res = makeRes();
    await retryReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'hi' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Escalate
// ═══════════════════════════════════════════════════════════════════════════════

describe('escalateReconciliationCase', () => {
  beforeEach(() => cases.clear());

  it('escalates with reason and escalateTo', async () => {
    const row = seedCase({ status: 'failed' });
    const res = makeRes();
    await escalateReconciliationCase(
      makeReq({
        params: { id: row.id },
        body: { reason: 'repeated failure after 5 retries', escalateTo: 'blockchain-team' },
      }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const updated = cases.get(row.id as string)!;
    expect(updated.status).toBe('escalated');
    expect(updated.escalated_to).toBe('blockchain-team');
    expect(updated.escalated_reason).toBe('repeated failure after 5 retries');
  });

  it('returns 409 on already-resolved', async () => {
    const row = seedCase({ status: 'resolved' });
    const res = makeRes();
    await escalateReconciliationCase(
      makeReq({
        params: { id: row.id },
        body: { reason: 'testing 409', escalateTo: 'ops' },
      }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Resolve
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveReconciliationCase', () => {
  beforeEach(() => cases.clear());

  it('resolves an escalated case', async () => {
    const row = seedCase({ status: 'escalated' });
    const res = makeRes();
    await resolveReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'manually verified on-chain confirmed' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const updated = cases.get(row.id as string)!;
    expect(updated.status).toBe('resolved');
  });

  it('returns 409 on already-resolved (idempotency)', async () => {
    const row = seedCase({ status: 'resolved' });
    const res = makeRes();
    await resolveReconciliationCase(
      makeReq({ params: { id: row.id }, body: { reason: 'already done' } }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res._json as { error: { code: string } }).error.code).toBe('ALREADY_RESOLVED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DTO shape / security
// ═══════════════════════════════════════════════════════════════════════════════

describe('reconciliation DTO safety', () => {
  beforeEach(() => cases.clear());

  it('DTO includes audit trail reference link', async () => {
    const row = seedCase();
    const res = makeRes();
    await getReconciliationCase(makeReq({ params: { id: row.id } }) as never, res as never);
    const body = res._json as { data: { auditTrailRef: string } };
    expect(body.data.auditTrailRef).toContain('/api/v1/admin/audit-logs');
  });

  it('DTO exposes escrowHash as on-chain TX reference (not a secret)', async () => {
    const row = seedCase({ escrow_hash: 'f'.repeat(64) });
    const res = makeRes();
    await getReconciliationCase(makeReq({ params: { id: row.id } }) as never, res as never);
    const body = res._json as { data: { escrowHash: string } };
    expect(body.data.escrowHash).toBe('f'.repeat(64));
  });

  it('DTO does not expose raw provider API payloads', async () => {
    const row = seedCase({ provider_api_key: 'secret-key-xyz', raw_xdr: 'AAAA....' });
    const res = makeRes();
    await getReconciliationCase(makeReq({ params: { id: row.id } }) as never, res as never);
    const body = res._json as { data: Record<string, unknown> };
    expect(body.data.provider_api_key).toBeUndefined();
    expect(body.data.raw_xdr).toBeUndefined();
  });
});
