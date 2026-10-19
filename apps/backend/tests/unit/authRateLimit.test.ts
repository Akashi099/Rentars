import { describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { RateLimiterRes } from 'rate-limiter-flexible';

// The limiter factory is injected, so no Redis connection is needed.
const { createAuthRouteLimiter, emailFromBody } = await import(
  '../../src/middleware/authRateLimit.middleware.js'
);

function res(points: number, msBeforeNext = 30_000) {
  return new RateLimiterRes(points, msBeforeNext, 1, false);
}

/** Memory-style limiter that allows `max` hits per key and records every key it sees. */
function countingLimiter(max: number) {
  const hits = new Map<string, number>();
  const seen: string[] = [];
  return {
    seen,
    consume: mock(async (key: string) => {
      seen.push(key);
      const count = (hits.get(key) ?? 0) + 1;
      hits.set(key, count);
      if (count > max) throw res(0);
      return res(max - count);
    }),
  };
}

/** Limiter whose store is down: rejects with a plain Error, not a RateLimiterRes. */
function brokenLimiter() {
  return {
    consume: mock(async () => {
      throw new Error('ECONNREFUSED');
    }),
  };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '203.0.113.5',
    method: 'POST',
    path: '/login',
    body: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, unknown> = {};
  const out: { status?: number; body?: any } = {};
  const response = {
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
    status(code: number) {
      out.status = code;
      return response;
    },
    json(body: unknown) {
      out.body = body;
      return response;
    },
  };
  return { response: response as unknown as Response, headers, out };
}

describe('createAuthRouteLimiter', () => {
  it('allows requests under the IP limit and calls next()', async () => {
    const limiter = countingLimiter(5);
    const middleware = createAuthRouteLimiter({ name: 'test-allow' }, () => limiter);
    const { response, out } = makeRes();
    const next = mock(() => {});

    await middleware(makeReq(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(out.status).toBeUndefined();
  });

  it('returns 429 with Retry-After once the IP bucket is exhausted', async () => {
    const limiter = countingLimiter(2);
    const middleware = createAuthRouteLimiter({ name: 'test-ip-429' }, () => limiter);

    for (let i = 0; i < 2; i++) {
      const { response } = makeRes();
      await middleware(
        makeReq(),
        response,
        mock(() => {})
      );
    }

    const { response, headers, out } = makeRes();
    const next = mock(() => {});
    await middleware(makeReq(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(429);
    expect(out.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(headers['Retry-After']).toBe(30);
  });

  it('does not let one NAT address exhaust another address', async () => {
    const limiter = countingLimiter(1);
    const middleware = createAuthRouteLimiter({ name: 'test-nat' }, () => limiter);

    const first = makeRes();
    await middleware(
      makeReq({ ip: '198.51.100.1' }),
      first.response,
      mock(() => {})
    );
    const blocked = makeRes();
    await middleware(
      makeReq({ ip: '198.51.100.1' }),
      blocked.response,
      mock(() => {})
    );
    expect(blocked.out.status).toBe(429);

    const other = makeRes();
    const next = mock(() => {});
    await middleware(makeReq({ ip: '198.51.100.2' }), other.response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('applies the account bucket on top of the IP bucket, keyed by hashed email', async () => {
    const ipLimiter = countingLimiter(100);
    const accountLimiter = countingLimiter(1);
    const factory = mock((prefix: string) =>
      prefix.endsWith(':acct') ? accountLimiter : ipLimiter
    );
    const middleware = createAuthRouteLimiter(
      { name: 'test-acct', accountKey: emailFromBody },
      factory as never
    );

    const body = { email: 'Victim@Example.com' };
    const first = makeRes();
    await middleware(
      makeReq({ ip: '192.0.2.1', body } as never),
      first.response,
      mock(() => {})
    );

    const second = makeRes();
    await middleware(
      makeReq({ ip: '192.0.2.2', body } as never),
      second.response,
      mock(() => {})
    );

    expect(second.out.status).toBe(429);
    expect(second.out.body.error.details.retryAfter).toBe(30);
    // The raw email must never reach the store.
    expect(accountLimiter.seen.every((key) => !key.includes('victim'))).toBe(true);
  });

  it('fails closed with 503 when the store is down on a sensitive route', async () => {
    const middleware = createAuthRouteLimiter({ name: 'test-closed', failClosed: true }, () =>
      brokenLimiter()
    );
    const { response, out } = makeRes();
    const next = mock(() => {});

    await middleware(makeReq(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(out.status).toBe(503);
    expect(out.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
  });

  it('falls back to the in-process limiter when the store is down and failClosed is false', async () => {
    // The shared store always fails; the per-process fallback is real memory and allows the request.
    const middleware = createAuthRouteLimiter({ name: 'test-open', failClosed: false }, () =>
      brokenLimiter()
    );
    const { response, out } = makeRes();
    const next = mock(() => {});

    await middleware(makeReq(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(out.status).toBeUndefined();
  });

  it('does not treat a store error as a rate-limit rejection', async () => {
    const middleware = createAuthRouteLimiter({ name: 'test-err' }, () => brokenLimiter());
    const { response, out } = makeRes();

    await middleware(
      makeReq(),
      response,
      mock(() => {})
    );

    expect(out.status).not.toBe(429);
  });
});
