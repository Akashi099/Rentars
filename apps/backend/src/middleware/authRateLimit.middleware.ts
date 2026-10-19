/**
 * Route-specific rate limits for authentication endpoints.
 *
 * Each limited route consumes two buckets:
 *   - ip:      shared-network friendly. Generous, so users behind one NAT are not
 *              throttled because a neighbour mistyped a password.
 *   - account: keyed by the normalized email or wallet address in the request body,
 *              hashed before use. Caps guessing against a single account no matter
 *              how many IPs the attacker rotates through.
 *
 * Failure behaviour (Redis store unavailable):
 *   - failClosed routes (every auth route by default) return 503 RATE_LIMIT_UNAVAILABLE.
 *     They do not fall back to a per-process limiter, since that would multiply the
 *     effective limit by the number of instances.
 *   - failClosed: false routes fall back to an in-memory limiter.
 *
 * Operator overrides (environment variables, all optional):
 *   AUTH_IP_RATE_POINTS              default 30   requests per IP per window
 *   AUTH_IP_RATE_WINDOW_SECONDS      default 60
 *   AUTH_ACCOUNT_RATE_POINTS         default 10   requests per account per window
 *   AUTH_ACCOUNT_RATE_WINDOW_SECONDS default 900
 *
 * Keys are hashed (see hashIdentity) so raw IPs and emails never reach the store
 * or the metrics. Bucket cardinality is bounded by the window: entries expire.
 */

import { redisClient } from '@/config/redis.js';
import { rateLimitMetrics } from '@/services/rateLimitMetrics.service.js';
import type { NextFunction, Request, Response } from 'express';
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { structuredLog } from './logging.middleware.js';
import { hashIdentity } from './rateLimiter.js';

export interface Limiter {
  consume(key: string): Promise<RateLimiterRes>;
}

export type LimiterFactory = (
  keyPrefix: string,
  points: number,
  durationSeconds: number
) => Limiter;

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export const authLimitDefaults = {
  get ipPoints() {
    return readPositiveInt('AUTH_IP_RATE_POINTS', 30);
  },
  get ipWindowSeconds() {
    return readPositiveInt('AUTH_IP_RATE_WINDOW_SECONDS', 60);
  },
  get accountPoints() {
    return readPositiveInt('AUTH_ACCOUNT_RATE_POINTS', 10);
  },
  get accountWindowSeconds() {
    return readPositiveInt('AUTH_ACCOUNT_RATE_WINDOW_SECONDS', 900);
  },
};

const memoryFactory: LimiterFactory = (keyPrefix, points, durationSeconds) =>
  new RateLimiterMemory({ keyPrefix, points, duration: durationSeconds });

const redisFactory: LimiterFactory = (keyPrefix, points, durationSeconds) =>
  new RateLimiterRedis({ storeClient: redisClient, keyPrefix, points, duration: durationSeconds });

const redisConfigured = !!process.env.REDIS_URL;

export interface AuthRouteLimitOptions {
  /** Route label used in key prefixes and logs, e.g. "login". */
  name: string;
  /** Returns the raw account identifier for the account bucket, or undefined to skip it. */
  accountKey?: (req: Request) => string | undefined;
  /** Refuse requests when the shared store is down. Defaults to true. */
  failClosed?: boolean;
  ipPoints?: number;
  ipWindowSeconds?: number;
  accountPoints?: number;
  accountWindowSeconds?: number;
}

type Outcome =
  | { status: 'allowed'; res: RateLimiterRes }
  | { status: 'limited'; res: RateLimiterRes }
  | { status: 'unavailable'; error: unknown };

interface Bucket {
  primary: Limiter;
  fallback: Limiter;
}

function makeBucket(
  keyPrefix: string,
  points: number,
  durationSeconds: number,
  factory: LimiterFactory
): Bucket {
  return {
    primary: factory(keyPrefix, points, durationSeconds),
    // The fallback is always per-process memory. It is only used for routes that
    // opt out of fail-closed behaviour.
    fallback: memoryFactory(`${keyPrefix}:local`, points, durationSeconds),
  };
}

async function consume(bucket: Bucket, key: string, failClosed: boolean): Promise<Outcome> {
  try {
    return { status: 'allowed', res: await bucket.primary.consume(key) };
  } catch (err) {
    // rate-limiter-flexible rejects with RateLimiterRes when the limit is hit,
    // and with an Error when the store itself fails. Those must not be confused.
    if (err instanceof RateLimiterRes) return { status: 'limited', res: err };
    if (failClosed) return { status: 'unavailable', error: err };
  }

  try {
    return { status: 'allowed', res: await bucket.fallback.consume(key) };
  } catch (err) {
    if (err instanceof RateLimiterRes) return { status: 'limited', res: err };
    return { status: 'unavailable', error: err };
  }
}

function setHeaders(res: Response, limiterRes: RateLimiterRes): void {
  res.setHeader('X-RateLimit-Limit', limiterRes.consumedPoints);
  res.setHeader('X-RateLimit-Remaining', limiterRes.remainingPoints);
  res.setHeader('X-RateLimit-Reset', new Date(Date.now() + limiterRes.msBeforeNext).toISOString());
}

/**
 * Builds the middleware for one route. `factory` is injectable for tests.
 */
export function createAuthRouteLimiter(
  options: AuthRouteLimitOptions,
  factory: LimiterFactory = redisConfigured ? redisFactory : memoryFactory
) {
  const failClosed = options.failClosed ?? true;
  const ipWindow = options.ipWindowSeconds ?? authLimitDefaults.ipWindowSeconds;
  const accountWindow = options.accountWindowSeconds ?? authLimitDefaults.accountWindowSeconds;

  const ipBucket = makeBucket(
    `rl:auth:${options.name}:ip`,
    options.ipPoints ?? authLimitDefaults.ipPoints,
    ipWindow,
    factory
  );
  const accountBucket = options.accountKey
    ? makeBucket(
        `rl:auth:${options.name}:acct`,
        options.accountPoints ?? authLimitDefaults.accountPoints,
        accountWindow,
        factory
      )
    : undefined;

  return async function authRouteLimiter(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const ipKey = hashIdentity(req.ip || 'unknown');
    const rawAccount = options.accountKey?.(req);

    const checks: Array<{ scope: 'ip' | 'account'; bucket: Bucket; key: string }> = [
      { scope: 'ip', bucket: ipBucket, key: ipKey },
    ];
    if (accountBucket && rawAccount) {
      checks.push({ scope: 'account', bucket: accountBucket, key: hashIdentity(rawAccount) });
    }

    let ipResult: RateLimiterRes | undefined;

    for (const check of checks) {
      const outcome = await consume(check.bucket, check.key, failClosed);

      if (outcome.status === 'unavailable') {
        structuredLog({
          level: 'error',
          message: 'Auth rate limit store unavailable',
          timestamp: new Date().toISOString(),
          route: options.name,
          failClosed,
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        });
        res.status(503).json({
          error: {
            code: 'RATE_LIMIT_UNAVAILABLE',
            message: 'Request could not be verified right now. Please try again shortly.',
          },
        });
        return;
      }

      if (outcome.status === 'limited') {
        const retryAfterSeconds = Math.max(1, Math.ceil(outcome.res.msBeforeNext / 1000));
        res.setHeader('Retry-After', retryAfterSeconds);
        setHeaders(res, outcome.res);

        try {
          await rateLimitMetrics.recordEvent(
            req.path,
            req.method,
            `auth:${options.name}:${check.scope}`,
            check.key
          );
        } catch {
          // Metrics must never change the response.
        }

        res.status(429).json({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many attempts. Please wait before trying again.',
            details: { retryAfter: retryAfterSeconds },
          },
        });
        return;
      }

      if (check.scope === 'ip') ipResult = outcome.res;
    }

    if (ipResult) setHeaders(res, ipResult);
    next();
  };
}

/** Email from the request body, normalized the same way the auth service normalizes it. */
export function emailFromBody(req: Request): string | undefined {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== 'string') return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized || undefined;
}

/** Stellar address from the request body, used to limit wallet challenge abuse per address. */
export function stellarAddressFromBody(req: Request): string | undefined {
  const address = (req.body as { stellar_address?: unknown } | undefined)?.stellar_address;
  return typeof address === 'string' && address.trim() ? address.trim() : undefined;
}
