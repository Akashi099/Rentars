import { beforeEach, describe, expect, it, mock } from 'bun:test';
import jwt from 'jsonwebtoken';

const SECRET = 'session-revocation-test-secret-32-chars';
process.env.JWT_SECRET = SECRET;

const store = new Map<string, string>();
let failReads = false;
const fakeRedis = {
  set: mock(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: mock(async (key: string) => {
    if (failReads) throw new Error('redis down');
    return store.get(key) ?? null;
  }),
};

mock.module('../../src/config/redis.js', () => ({ redisClient: fakeRedis }));

const { sessionRevocationGuard } = await import(
  '../../src/middleware/sessionRevocation.middleware.js'
);
const { markUserSessionsRevoked, getSessionRevokedBefore } = await import(
  '../../src/services/sessionRevocation.service.js'
);

function makeRes() {
  const out: { status?: number; body?: any } = {};
  const response: any = {
    status(code: number) {
      out.status = code;
      return response;
    },
    json(body: unknown) {
      out.body = body;
      return response;
    },
  };
  return { response, out };
}

function bearer(userId: string, issuedAtSeconds: number): string {
  return `Bearer ${jwt.sign({ userId, iat: issuedAtSeconds }, SECRET)}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('sessionRevocationGuard', () => {
  beforeEach(() => {
    store.clear();
    failReads = false;
  });

  it('rejects a token issued before the user session was revoked', async () => {
    const issuedAt = nowSeconds() - 120;
    await markUserSessionsRevoked('user-1', new Date());

    const { response, out } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard(
      { headers: { authorization: bearer('user-1', issuedAt) } } as any,
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(401);
    expect(out.body.error.code).toBe('SESSION_REVOKED');
  });

  it('accepts a token issued after the revocation', async () => {
    await markUserSessionsRevoked('user-2', new Date(Date.now() - 60_000));

    const { response } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard(
      { headers: { authorization: bearer('user-2', nowSeconds()) } } as any,
      response,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not affect other users', async () => {
    await markUserSessionsRevoked('user-3', new Date());

    const { response } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard(
      { headers: { authorization: bearer('user-4', nowSeconds() - 300) } } as any,
      response,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 503 when the revocation marker cannot be read', async () => {
    failReads = true;

    const { response, out } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard(
      { headers: { authorization: bearer('user-5', nowSeconds()) } } as any,
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(503);
    expect(out.body.error.code).toBe('SESSION_CHECK_UNAVAILABLE');
  });

  it('passes requests without a Bearer token through to route-level auth', async () => {
    const { response } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard({ headers: {} } as any, response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes invalid tokens through so authenticate() produces the 401', async () => {
    const { response } = makeRes();
    const next = mock(() => {});
    await sessionRevocationGuard(
      { headers: { authorization: 'Bearer not-a-jwt' } } as any,
      response,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('markUserSessionsRevoked', () => {
  it('stores the cutoff in unix seconds with a TTL', async () => {
    const at = new Date('2030-01-01T00:00:10.500Z');
    await markUserSessionsRevoked('user-6', at);
    expect(await getSessionRevokedBefore('user-6')).toBe(Math.floor(at.getTime() / 1000));
    const [, , options] = (fakeRedis.set as any).mock.calls.at(-1);
    expect(options.EX).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
  });
});
