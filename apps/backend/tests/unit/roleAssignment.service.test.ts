/**
 * Service tests for role assignment (#916): authority is re-read from the DB,
 * the update is compare-and-set, and every attempt is audited.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

type Result = { data?: unknown; error?: unknown; count?: number };

const state: { queue: Result[]; updates: Array<{ role: string }>; eqs: Array<[string, unknown]> } =
  {
    queue: [],
    updates: [],
    eqs: [],
  };

// Each supabase.from() call consumes the next queued result. The chain is
// awaitable (for the count query) and ends in maybeSingle() for the others.
type Chain = Record<string, unknown> & PromiseLike<unknown>;

function chain(): Chain {
  const c = {} as Chain;
  for (const m of ['select', 'eq', 'update']) {
    c[m] = (...args: unknown[]) => {
      if (m === 'eq') state.eqs.push([String(args[0]), args[1]]);
      if (m === 'update') state.updates.push(args[0] as { role: string });
      return c;
    };
  }
  const next = state.queue.shift() ?? { data: null, error: null };
  c.maybeSingle = async () => next;
  // biome-ignore lint/suspicious/noThenProperty: mirrors Supabase's awaitable query builder
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve({ count: next.count ?? 0, error: null }).then(res, rej);
  return c;
}

const fakeSupabase = { from: mock((_: string) => chain()) };
mock.module('../../src/config/supabase.js', () => ({ supabase: fakeSupabase }));

const auditMod = await import('../../src/services/auditLogger.service.js');
const logMock = mock(async (_entry: unknown) => {});
(auditMod.auditLogger as unknown as { log: typeof logMock }).log = logMock;

const { changeUserRole } = await import('../../src/services/roleAssignment.service.js');

const params = {
  actorId: 'admin-1',
  targetId: 'user-2',
  toRole: 'host' as const,
  requestId: 'req-123',
  ip: '10.0.0.1',
};

beforeEach(() => {
  state.queue = [];
  state.updates = [];
  state.eqs = [];
  logMock.mockClear();
});

describe('changeUserRole', () => {
  it('updates the role with a compare-and-set and audits success', async () => {
    state.queue = [
      { data: { role: 'admin' } }, // actor
      { data: { id: 'user-2', role: 'tenant' } }, // target
      { count: 2 }, // admin count
      { data: { id: 'user-2' } }, // update returned a row
    ];
    const result = await changeUserRole(params);

    expect(result).toEqual({ ok: true, userId: 'user-2', oldRole: 'tenant', newRole: 'host' });
    expect(state.updates).toEqual([{ role: 'host' }]);
    expect(state.eqs).toContainEqual(['role', 'tenant']);

    const audit = logMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(audit).toMatchObject({
      actorId: 'admin-1',
      action: 'admin.user_role_change',
      resourceId: 'user-2',
      correlationId: 'req-123',
      success: true,
      meta: { old_role: 'tenant', new_role: 'host' },
    });
  });

  it('refuses when the actor is only a moderator in the database, regardless of the request', async () => {
    state.queue = [
      { data: { role: 'moderator' } },
      { data: { id: 'user-2', role: 'tenant' } },
      { count: 2 },
    ];
    const result = await changeUserRole(params);

    expect(result).toMatchObject({ ok: false, status: 403, code: 'ACTOR_NOT_ADMIN' });
    expect(state.updates).toEqual([]);
    expect(logMock.mock.calls[0]![0]).toMatchObject({
      action: 'admin.user_role_change_denied',
      success: false,
    });
  });

  it('returns 404 for an unknown target and writes nothing', async () => {
    state.queue = [{ data: { role: 'admin' } }, { data: null }];
    const result = await changeUserRole(params);
    expect(result).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    expect(state.updates).toEqual([]);
  });

  it('reports a concurrent change instead of overwriting it', async () => {
    state.queue = [
      { data: { role: 'admin' } },
      { data: { id: 'user-2', role: 'tenant' } },
      { count: 2 },
      { data: null }, // CAS matched no row
    ];
    const result = await changeUserRole(params);
    expect(result).toMatchObject({ ok: false, status: 409, code: 'CONCURRENT_UPDATE' });
  });

  it('refuses self-promotion without touching the target row', async () => {
    state.queue = [
      { data: { role: 'admin' } },
      { data: { id: 'admin-1', role: 'admin' } },
      { count: 2 },
    ];
    const result = await changeUserRole({ ...params, targetId: 'admin-1', toRole: 'moderator' });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'SELF_ROLE_CHANGE' });
    expect(state.updates).toEqual([]);
  });
});
