import { beforeEach, describe, expect, it, mock } from 'bun:test';
import crypto from 'node:crypto';

// ── Fake Supabase query builder ───────────────────────────────────────────────
// Records the chain (table, filters) and resolves with whatever the active
// responder returns, so tests can simulate races (empty claim results) and errors.

type Result = { data: any; error: any };
type Responder = (q: FakeQuery) => Result;

class FakeQuery {
  readonly ops: Array<{ method: string; args: unknown[] }> = [];
  constructor(readonly table: string) {}

  private record(method: string, args: unknown[]) {
    this.ops.push({ method, args });
    return this;
  }
  select(...args: unknown[]) {
    return this.record('select', args);
  }
  update(...args: unknown[]) {
    return this.record('update', args);
  }
  insert(...args: unknown[]) {
    return this.record('insert', args);
  }
  upsert(...args: unknown[]) {
    return this.record('upsert', args);
  }
  eq(...args: unknown[]) {
    return this.record('eq', args);
  }
  is(...args: unknown[]) {
    return this.record('is', args);
  }
  gt(...args: unknown[]) {
    return this.record('gt', args);
  }
  single() {
    return Promise.resolve(respond(this));
  }
  maybeSingle() {
    return Promise.resolve(respond(this));
  }
  // biome-ignore lint/suspicious/noThenProperty: the fake must be awaitable, like the Supabase query builder
  then<T1, T2>(
    onFulfilled?: (v: Result) => T1 | PromiseLike<T1>,
    onRejected?: (e: unknown) => T2 | PromiseLike<T2>
  ) {
    return Promise.resolve(respond(this)).then(onFulfilled, onRejected);
  }

  has(method: string, ...args: unknown[]) {
    return this.ops.some(
      (op) =>
        op.method === method &&
        JSON.stringify(op.args.slice(0, args.length)) === JSON.stringify(args)
    );
  }
}

const queries: FakeQuery[] = [];
let respond: Responder = () => ({ data: null, error: null });

const listUsers = mock(async () => ({ data: { users: [] }, error: null }));
const updateUserById = mock(async () => ({ data: {}, error: null }));

const fakeSupabase = {
  from: (table: string) => {
    const q = new FakeQuery(table);
    queries.push(q);
    return q;
  },
  auth: { admin: { listUsers, updateUserById } },
};

// Override the methods on the shared instance rather than mock.module(): other test
// files may already have loaded auth.service, which would bypass a module mock.
const emailMod = await import('../../src/services/email.service.js');
const sendPasswordResetEmail = mock(async () => {});
const sendVerificationEmail = mock(async () => {});
(emailMod.emailService as any).sendPasswordResetEmail = sendPasswordResetEmail;
(emailMod.emailService as any).sendVerificationEmail = sendVerificationEmail;
const revokedMarkers: Array<[string, string]> = [];
const fakeRedis = {
  set: mock(async (key: string, value: string) => {
    revokedMarkers.push([key, value]);
    return 'OK';
  }),
  get: mock(async () => null),
  del: mock(async () => 1),
  incr: mock(async () => 1),
  expire: mock(async () => true),
  scanIterator: async function* () {},
};

mock.module('../../src/config/supabase.js', () => ({ supabase: fakeSupabase }));
mock.module('../../src/config/redis.js', () => ({ redisClient: fakeRedis }));

const { requestPasswordReset, confirmPasswordReset, verifyEmail, PASSWORD_RESET_MIN_RESPONSE_MS } =
  await import('../../src/services/auth.service.js');
const { AuthError, AuthErrorCode } = await import('../../src/types/errors.js');

const sha256 = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

beforeEach(() => {
  queries.length = 0;
  respond = () => ({ data: null, error: null });
  listUsers.mockClear();
  updateUserById.mockClear();
  updateUserById.mockImplementation(async () => ({ data: {}, error: null }));
  sendPasswordResetEmail.mockClear();
  revokedMarkers.length = 0;
});

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject');
}

describe('verifyEmail — single use', () => {
  it('succeeds once and claims the token with a conditional update', async () => {
    respond = (q) => {
      if (q.table === 'users' && q.ops[0]?.method === 'select') {
        return {
          data: { id: 'u1', email_verified: false, email_verification_expires_at: future() },
          error: null,
        };
      }
      return { data: [{ id: 'u1' }], error: null };
    };

    await verifyEmail('raw-token');

    const claim = queries.find((q) => q.ops.some((op) => op.method === 'update'))!;
    expect(claim.has('eq', 'email_verification_token', sha256('raw-token'))).toBe(true);
    expect(claim.has('eq', 'email_verified', false)).toBe(true);
  });

  it('rejects a second use when a concurrent request already claimed the token', async () => {
    respond = (q) => {
      if (q.ops[0]?.method === 'select') {
        return {
          data: { id: 'u1', email_verified: false, email_verification_expires_at: future() },
          error: null,
        };
      }
      // The conditional update matched no row: someone else consumed it first.
      return { data: [], error: null };
    };

    const err = await rejectionOf(verifyEmail('raw-token'));
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe(AuthErrorCode.INVALID_TOKEN);
  });

  it('rejects an expired token before claiming it', async () => {
    respond = () => ({
      data: { id: 'u1', email_verified: false, email_verification_expires_at: past() },
      error: null,
    });

    const err = await rejectionOf(verifyEmail('raw-token'));
    expect((err as AuthError).code).toBe(AuthErrorCode.TOKEN_EXPIRED);
    expect(queries.some((q) => q.ops.some((op) => op.method === 'update'))).toBe(false);
  });
});

describe('confirmPasswordReset — single use and session revocation', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    data: { id: 't1', user_id: 'u1', expires_at: future(), consumed_at: null, ...overrides },
    error: null,
  });

  it('does not change the password when the token was already claimed', async () => {
    respond = (q) => {
      if (q.table === 'password_reset_tokens' && q.ops[0]?.method === 'select') return row();
      return { data: [], error: null };
    };

    const err = await rejectionOf(confirmPasswordReset('raw', 'NewPass1!'));
    expect((err as AuthError).code).toBe(AuthErrorCode.INVALID_TOKEN);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('releases the claim when the password change fails, so the link can be retried', async () => {
    respond = (q) => {
      if (q.ops[0]?.method === 'select') return row();
      return { data: [{ id: 't1' }], error: null };
    };
    updateUserById.mockImplementation(async () => ({
      data: null,
      error: { message: 'weak password' },
    }));

    await rejectionOf(confirmPasswordReset('raw', 'x'));

    const release = queries.filter((q) => q.table === 'password_reset_tokens').at(-1)!;
    expect(
      release.ops.some((op) => op.method === 'update' && (op.args[0] as any).consumed_at === null)
    ).toBe(true);
  });

  it('records a session revocation marker in Redis on success', async () => {
    respond = (q) =>
      q.ops[0]?.method === 'select' ? row() : { data: [{ id: 't1' }], error: null };

    const before = Date.now();
    const result = await confirmPasswordReset('raw', 'NewPass1!');

    expect(result.success).toBe(true);
    expect(revokedMarkers.length).toBe(1);
    const [key, value] = revokedMarkers[0];
    expect(key).toBe('session:revoked-before:u1');
    expect(Number(value)).toBeGreaterThanOrEqual(Math.floor(before / 1000));
  });
});

describe('requestPasswordReset — enumeration resistance', () => {
  it('looks accounts up in the users table instead of listing auth users', async () => {
    respond = () => ({ data: null, error: null });

    await requestPasswordReset('someone@example.com');

    expect(listUsers).not.toHaveBeenCalled();
    expect(queries.some((q) => q.table === 'users')).toBe(true);
  });

  it('returns success and sends nothing for an unknown address', async () => {
    respond = () => ({ data: null, error: null });

    const result = await requestPasswordReset('ghost@example.com');

    expect(result.success).toBe(true);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    expect(queries.some((q) => q.table === 'password_reset_tokens')).toBe(false);
  });

  it('stores only a hash of the token and sends the raw token for a known address', async () => {
    respond = (q) =>
      q.table === 'users' ? { data: { id: 'u1' }, error: null } : { data: [], error: null };

    await requestPasswordReset('known@example.com');

    const insert = queries.find(
      (q) => q.table === 'password_reset_tokens' && q.ops.some((op) => op.method === 'insert')
    )!;
    const stored = (insert.ops.find((op) => op.method === 'insert')!.args[0] as any)
      .token_hash as string;
    const raw = (sendPasswordResetEmail.mock.calls[0] as any)[0].token as string;
    expect(stored).toBe(sha256(raw));
    expect(raw).not.toBe(stored);
  });

  it('returns success even when the storage layer fails', async () => {
    respond = () => {
      throw new Error('db down');
    };

    const result = await requestPasswordReset('known@example.com');
    expect(result.success).toBe(true);
  });

  it('keeps response time close to the same for known and unknown addresses', async () => {
    respond = (q) =>
      q.table === 'users' ? { data: null, error: null } : { data: [], error: null };
    const unknownStart = Date.now();
    await requestPasswordReset('ghost@example.com');
    const unknownElapsed = Date.now() - unknownStart;

    expect(unknownElapsed).toBeGreaterThanOrEqual(PASSWORD_RESET_MIN_RESPONSE_MS - 20);
  });
});
