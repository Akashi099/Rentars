import { beforeEach, describe, expect, it, mock } from 'bun:test';
import jwt from 'jsonwebtoken';

// ── Supabase fake ─────────────────────────────────────────────────────────────
// Each `from(table)` returns a chainable builder. The handler decides the result
// from the table name and the recorded operations, so tests can simulate any
// query shape without a database.

type Op = { method: string; args: unknown[] };
type Result = { data: unknown; error: unknown };
type Handler = (table: string, ops: Op[]) => Result | Promise<Result>;

const fake: { handler: Handler; writes: Array<{ table: string; ops: Op[] }> } = {
  handler: () => ({ data: null, error: null }),
  writes: [],
};

function builder(table: string): Record<string, unknown> {
  const ops: Op[] = [];
  const chain: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      ops.push({ method, args });
      return chain;
    };

  for (const method of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'in',
    'lt',
    'limit',
    'order',
  ]) {
    chain[method] = record(method);
  }
  chain.single = () => fake.handler(table, ops);
  chain.maybeSingle = () => fake.handler(table, ops);
  // biome-ignore lint/suspicious/noThenProperty: the builder is awaited like a Supabase query
  chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) => {
    const isWrite = ops.some((o) => ['insert', 'update', 'delete'].includes(o.method));
    if (isWrite) fake.writes.push({ table, ops });
    return Promise.resolve(fake.handler(table, ops)).then(resolve, reject);
  };
  return chain;
}

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: (table: string) => builder(table) },
}));

const auditCalls: unknown[] = [];
mock.module('../../src/services/auditLogger.service.js', () => ({
  auditLogger: {
    log: async (entry: unknown) => {
      auditCalls.push(entry);
    },
  },
}));

const privacy = await import('../../src/services/privacy.service.js');
const handlers = await import('../../src/controllers/privacy.controller.js');
const { getJwtSecret } = await import('../../src/config/jwtSecret.js');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SECRET = 'x'.repeat(48);

/** Default backing state; individual tests override pieces via `fake.handler`. */
function defaultHandler(state: {
  bookings?: Result;
  pendingDeletion?: unknown;
  dueDeletions?: unknown[];
}): Handler {
  return (table, ops) => {
    if (table === 'bookings') {
      const isHost = ops.some((o) => o.method === 'eq' && o.args[0] === 'properties.owner_id');
      return isHost ? { data: [], error: null } : (state.bookings ?? { data: [], error: null });
    }
    if (table === 'account_deletions') {
      const isDue = ops.some((o) => o.method === 'lt');
      if (isDue) return { data: state.dueDeletions ?? [], error: null };
      return { data: state.pendingDeletion ?? null, error: null };
    }
    return { data: null, error: null };
  };
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  fake.writes = [];
  auditCalls.length = 0;
  fake.handler = defaultHandler({});
});

describe('getJwtSecret', () => {
  it('throws instead of falling back to a default when unset', () => {
    const saved = process.env.JWT_SECRET;
    Reflect.deleteProperty(process.env, 'JWT_SECRET');
    expect(() => getJwtSecret()).toThrow();
    process.env.JWT_SECRET = saved;
  });

  it('throws when the secret is too short', () => {
    process.env.JWT_SECRET = 'short';
    expect(() => getJwtSecret()).toThrow();
  });
});

describe('getActiveFinancialObligations', () => {
  it('returns open bookings from both tenant and host perspectives', async () => {
    fake.handler = (table, ops) => {
      if (table !== 'bookings') return { data: null, error: null };
      const isHost = ops.some((o) => o.method === 'eq' && o.args[0] === 'properties.owner_id');
      return isHost
        ? { data: [{ id: 'b-host', status: 'Disputed' }], error: null }
        : { data: [{ id: 'b-tenant', status: 'Confirmed' }], error: null };
    };

    const obligations = await privacy.getActiveFinancialObligations(USER);

    expect(obligations).toEqual([
      { booking_id: 'b-tenant', status: 'Confirmed', role: 'tenant' },
      { booking_id: 'b-host', status: 'Disputed', role: 'host' },
    ]);
  });

  it('fails closed when the query errors', async () => {
    fake.handler = () => ({ data: null, error: { message: 'boom' } });
    await expect(privacy.getActiveFinancialObligations(USER)).rejects.toThrow(
      'Failed to check active obligations'
    );
  });
});

describe('requestAccountDeletion', () => {
  it('refuses while the user has an open booking and writes nothing', async () => {
    fake.handler = defaultHandler({
      bookings: { data: [{ id: 'b1', status: 'Pending' }], error: null },
    });

    await expect(privacy.requestAccountDeletion(USER, '203.0.113.1')).rejects.toBeInstanceOf(
      privacy.DeletionBlockedError
    );
    expect(fake.writes.filter((w) => w.table === 'account_deletions')).toHaveLength(0);
  });

  it('returns the existing pending request instead of creating a second one', async () => {
    const existing = { id: 'del-1', user_id: USER, status: 'pending' };
    fake.handler = defaultHandler({ pendingDeletion: existing });

    const result = await privacy.requestAccountDeletion(USER, '203.0.113.1');

    expect(result).toEqual(existing);
    expect(fake.writes.filter((w) => w.table === 'account_deletions')).toHaveLength(0);
  });

  it('creates a pending request whose cancel token is signed with JWT_SECRET', async () => {
    let inserted: Record<string, unknown> | undefined;
    fake.handler = (table, ops) => {
      if (table === 'account_deletions') {
        const insert = ops.find((o) => o.method === 'insert');
        if (insert) {
          inserted = insert.args[0] as Record<string, unknown>;
          return { data: inserted, error: null };
        }
        return { data: null, error: null };
      }
      return defaultHandler({})(table, ops);
    };

    await privacy.requestAccountDeletion(USER, '203.0.113.1');

    expect(inserted?.status).toBe('pending');
    expect(inserted?.user_id).toBe(USER);
    const decoded = jwt.verify(inserted?.cancel_token as string, SECRET) as { user_id: string };
    expect(decoded.user_id).toBe(USER);
  });
});

describe('executeAccountDeletion', () => {
  it('blocks and leaves the account untouched when obligations appeared after the request', async () => {
    fake.handler = defaultHandler({
      bookings: { data: [{ id: 'b2', status: 'Confirmed' }], error: null },
    });

    const outcome = await privacy.executeAccountDeletion(USER, 'del-1', 'worker');

    expect(outcome).toBe('blocked');
    expect(fake.writes.some((w) => w.table === 'users')).toBe(false);
    expect(
      fake.writes.some(
        (w) => w.table === 'account_deletions' && w.ops.some((o) => o.method === 'update')
      )
    ).toBe(true);
  });

  it('anonymises the user, clears export payloads and marks the request completed', async () => {
    const outcome = await privacy.executeAccountDeletion(USER, 'del-1', 'worker');

    expect(outcome).toBe('completed');
    const userWrite = fake.writes.find((w) => w.table === 'users');
    const userUpdate = userWrite?.ops.find((o) => o.method === 'update')?.args[0] as Record<
      string,
      unknown
    >;
    expect(userUpdate.email).toBe(`deleted-${USER}@rentars.invalid`);
    expect(userUpdate.status).toBe('deleted');

    const tablesDeleted = fake.writes
      .filter((w) => w.ops.some((o) => o.method === 'delete'))
      .map((w) => w.table);
    expect(tablesDeleted).toEqual(
      expect.arrayContaining([
        'notifications',
        'notification_preferences',
        'push_subscriptions',
        'refresh_tokens',
        'saved_searches',
      ])
    );

    const exportWrite = fake.writes.find((w) => w.table === 'data_exports');
    expect(exportWrite?.ops.find((o) => o.method === 'update')?.args[0]).toEqual({
      export_payload: null,
    });

    const completion = fake.writes.find((w) => w.table === 'account_deletions');
    const completionUpdate = completion?.ops.find((o) => o.method === 'update')?.args[0] as Record<
      string,
      unknown
    >;
    expect(completionUpdate.status).toBe('completed');
    expect(completionUpdate.anonymised_at).toBeDefined();
  });

  it('keeps the request pending (for retry) when a step fails', async () => {
    fake.handler = (table, ops) => {
      if (table === 'users' && ops.some((o) => o.method === 'update')) {
        return { data: null, error: { message: 'connection reset' } };
      }
      return defaultHandler({})(table, ops);
    };

    await expect(privacy.executeAccountDeletion(USER, 'del-1', 'worker')).rejects.toThrow(
      'connection reset'
    );
    expect(
      fake.writes.some(
        (w) =>
          w.table === 'account_deletions' &&
          w.ops.some(
            (o) => o.args[0] && (o.args[0] as Record<string, unknown>).status === 'completed'
          )
      )
    ).toBe(false);
  });
});

describe('cancelAccountDeletion', () => {
  it('refuses once the cancellation window has closed', async () => {
    fake.handler = (table) =>
      table === 'account_deletions'
        ? {
            data: {
              id: 'del-1',
              user_id: USER,
              status: 'pending',
              cancel_expires_at: new Date(Date.now() - 1000).toISOString(),
            },
            error: null,
          }
        : { data: null, error: null };

    expect(await privacy.cancelAccountDeletion(USER, 'del-1', '203.0.113.1')).toBe(false);
  });
});

describe('getDataExportStatus', () => {
  it('never returns a payload after expiry, even if cleanup has not run', async () => {
    fake.handler = () => ({
      data: {
        id: 'exp-1',
        user_id: USER,
        status: 'completed',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        export_payload: { profile: { secret: true } },
      },
      error: null,
    });

    const result = await privacy.getDataExportStatus(USER, 'exp-1');

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('export_payload');
  });

  it('returns the payload for a completed, unexpired export', async () => {
    fake.handler = () => ({
      data: {
        id: 'exp-1',
        user_id: USER,
        status: 'completed',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        export_payload: { profile: null },
      },
      error: null,
    });

    const result = (await privacy.getDataExportStatus(USER, 'exp-1')) as {
      export_payload?: unknown;
    };
    expect(result.export_payload).toEqual({ profile: null });
  });
});

describe('processDataExport', () => {
  it('marks the request failed (not completed) when generation errors', async () => {
    fake.handler = (table) => {
      if (table === 'profiles') return { data: null, error: { message: 'db down', code: 'XX000' } };
      return { data: [], error: null };
    };

    await privacy.processDataExport(USER, 'exp-1');

    const update = fake.writes.find((w) => w.table === 'data_exports');
    const payload = update?.ops.find((o) => o.method === 'update')?.args[0] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('failed');
  });
});

describe('processDueAccountDeletions', () => {
  it('processes each due request independently and summarises the outcomes', async () => {
    const due = [
      { id: 'd-ok', user_id: USER },
      { id: 'd-blocked', user_id: OTHER },
    ];
    fake.handler = (table, ops) => {
      if (table === 'account_deletions' && ops.some((o) => o.method === 'lt')) {
        return { data: due, error: null };
      }
      if (table === 'bookings') {
        const isHost = ops.some((o) => o.method === 'eq' && o.args[0] === 'properties.owner_id');
        const owner = ops.find((o) => o.method === 'eq' && o.args[0] === 'tenant_id')?.args[1];
        if (!isHost && owner === OTHER)
          return { data: [{ id: 'b-open', status: 'Pending' }], error: null };
        return { data: [], error: null };
      }
      return defaultHandler({})(table, ops);
    };

    const summary = await privacy.processDueAccountDeletions(new Date(), 10);

    expect(summary).toEqual({ processed: 2, completed: 1, blocked: 1, failed: 0 });
  });
});

describe('privacy handlers', () => {
  // Handlers are called directly. Middleware is not mocked here, because mock.module
  // is process-wide and would leak into other test files.
  type Captured = { status?: number; body?: unknown };

  function fakeResponse(captured: Captured) {
    const res = {
      status(code: number) {
        captured.status = code;
        return res;
      },
      json(body: unknown) {
        captured.body = body;
        return res;
      },
    };
    return res;
  }

  function request(body: unknown, authenticated = true) {
    return {
      userId: authenticated ? USER : undefined,
      body,
      ip: '203.0.113.7',
      params: {},
    } as never;
  }

  it('rejects deletion without the exact confirmation phrase', async () => {
    const captured: Captured = {};
    await handlers.requestDeletion(
      request({ password: 'pw', confirmation: 'yes' }),
      fakeResponse(captured) as never
    );

    expect(captured.status).toBe(400);
    expect(fake.writes.some((w) => w.table === 'account_deletions')).toBe(false);
  });

  it('rejects deletion with a wrong password before touching any data', async () => {
    fake.handler = (table) =>
      table === 'users'
        ? {
            data: { password_hash: '$2b$10$invalidhashinvalidhashinvalidhashinvalidhashinvalid' },
            error: null,
          }
        : { data: null, error: null };
    const captured: Captured = {};

    await handlers.requestDeletion(
      request({ password: 'wrong', confirmation: 'DELETE MY ACCOUNT' }),
      fakeResponse(captured) as never
    );

    expect(captured.status).toBe(401);
    expect(fake.writes.some((w) => w.table === 'account_deletions')).toBe(false);
  });

  it('returns 401 for a request with no authenticated user', async () => {
    const captured: Captured = {};
    await handlers.startExport(request({}, false), fakeResponse(captured) as never);

    expect(captured.status).toBe(401);
  });
});
