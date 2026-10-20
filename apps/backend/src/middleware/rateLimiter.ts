import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';
import { createHash } from 'node:crypto';
import { redisClient } from '@/config/redis.js';
import { loggingService } from '@/services/logging.service.js';
import { rateLimitStore } from '@/services/rateLimitStore.service.js';
import { rateLimitMetrics } from '@/services/rateLimitMetrics.service.js';
import {
  paymentAttemptLimiter,
  type PaymentAttemptLimitResult,
} from '@/services/paymentAttemptLimiter.service.js';
import { paymentCircuitBreaker } from '@/services/paymentCircuitBreaker.service.js';

export interface AuthRequest extends Request {
  userId?: string;
}

// Rate limiter instances
let generalLimiter: RateLimiterRedis | RateLimiterMemory;
let authLimiter: RateLimiterRedis | RateLimiterMemory;
let bookingLimiter: RateLimiterRedis | RateLimiterMemory;
let blockchainLimiter: RateLimiterRedis | RateLimiterMemory;
let messageLimiter: RateLimiterRedis | RateLimiterMemory;

const useRedis = !!process.env.REDIS_URL;

if (useRedis) {
  generalLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:general',
    points: 100,
    duration: 60,
  });

  authLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:auth',
    points: 10,
    duration: 60,
  });

  bookingLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:booking',
    points: 5,
    duration: 60,
  });

  blockchainLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:blockchain',
    points: 20,
    duration: 60,
  });

  messageLimiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl:message',
    points: 10,
    duration: 60,
  });
} else {
  generalLimiter = new RateLimiterMemory({ points: 100, duration: 60 });
  authLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
  bookingLimiter = new RateLimiterMemory({ points: 5, duration: 60 });
  blockchainLimiter = new RateLimiterMemory({ points: 20, duration: 60 });
  messageLimiter = new RateLimiterMemory({ points: 10, duration: 60 });
}

function setRateLimitHeaders(res: Response, limiterRes: any): void {
  res.setHeader('X-RateLimit-Limit', limiterRes.consumedPoints);
  res.setHeader('X-RateLimit-Remaining', limiterRes.remainingPoints);
  res.setHeader('X-RateLimit-Reset', new Date(Date.now() + limiterRes.msBeforeNext).toISOString());
}

/**
 * Hash an identity string (IP or userId) before recording it so we don't
 * persist raw personally-identifiable data in the metrics store.
 */
export function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Apply progressive delay based on consecutive failures.
 * This increases the cost of brute-force attacks over time.
 */
async function getProgressiveDelay(
  storeKey: string,
): Promise<number> {
  const failureCountKey = `${storeKey}:failures`;
  const failureCount = await redisClient.incr(failureCountKey);

  // Set expiry on failure counter if first failure
  if (failureCount === 1) {
    await redisClient.expire(failureCountKey, 3600); // 1 hour
  }

  // Progressive delays: 0ms, 100ms, 500ms, 1s, 2s, 5s, 10s...
  const delays = [0, 100, 500, 1000, 2000, 5000, 10000];
  const delayIndex = Math.min(failureCount - 1, delays.length - 1);

  return delays[delayIndex] || 10000; // Cap at 10 seconds
}

/**
 * Record a rate-limit rejection and send the 429 response.
 * Identity is hashed before storage — raw IPs/user IDs are never persisted.
 * Applies progressive delays to discourage brute-force attacks.
 * Records metrics for monitoring and alerting.
 */
async function handleRejection(
  req: Request,
  res: Response,
  limiterRes: any,
  scope: string,
  rawIdentity: string,
  message: string,
): Promise<void> {
  setRateLimitHeaders(res, limiterRes);
  res.setHeader('Retry-After', Math.ceil(limiterRes.msBeforeNext / 1000));

  // Record the rejection — identity is hashed for privacy
  const hashedIdentity = hashIdentity(rawIdentity);
  const storeKey = `abuse:${scope}:${hashedIdentity}`;

  await rateLimitStore.record({
    route: req.path,
    method: req.method,
    scope,
    hashedIdentity,
    timestamp: Date.now(),
  });

  // Track abuse metrics
  await rateLimitMetrics.recordEvent(req.path, req.method, scope, hashedIdentity);

  // Calculate progressive delay
  const progressiveDelay = await getProgressiveDelay(storeKey);

  loggingService.logBlockchainOperation(
    'rate_limit_exceeded',
    { scope, route: req.path, method: req.method, progressiveDelay },
    undefined,
    message,
  );

  // Apply progressive delay before sending response
  if (progressiveDelay > 0) {
    await new Promise(resolve => setTimeout(resolve, progressiveDelay));
  }

  res.status(429).json({
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message,
      details: {
        retryAfter: Math.ceil(limiterRes.msBeforeNext / 1000) + Math.ceil(progressiveDelay / 1000),
      },
    },
  });
}

export function generalRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || 'unknown';

  generalLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'general', key, 'Too many requests, please try again later.');
    });
}

export function authRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip || 'unknown';

  authLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'auth', key, 'Too many authentication requests, please try again later.');
    });
}

export function bookingRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  bookingLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'booking', key, 'Too many booking requests, please try again later.');
    });
}

export function blockchainRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  blockchainLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'blockchain', key, 'Too many blockchain operations, please try again later.');
    });
}

export function messageRateLimiter(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.userId || req.ip || 'unknown';

  messageLimiter
    .consume(key)
    .then((limiterRes) => {
      setRateLimitHeaders(res, limiterRes);
      next();
    })
    .catch((limiterRes) => {
      handleRejection(req, res, limiterRes, 'message', key, 'Too many messages sent, please slow down.');
    });
}

/**
 * Factory that creates a per-user rate-limiter middleware.
 *
 * The limiter key is resolved from `req.user?.id` (the authenticated user id)
 * so that two users sharing the same NAT/IP are tracked independently.
 * When no authenticated user is present the key falls back to the client IP.
 *
 * @param windowMs  - Sliding window length in milliseconds.
 * @param max       - Maximum number of requests allowed in the window.
 * @param keyPrefix - Redis key namespace (e.g. "rl:user:booking").
 *
 * @example
 * ```ts
 * const bookingCreationLimiter = createUserRateLimiter({
 *   windowMs: env.BOOKING_RATE_LIMIT_WINDOW_MS,
 *   max: env.BOOKING_RATE_LIMIT_MAX,
 *   keyPrefix: 'rl:user:booking',
 * });
 * ```
 */
export function createUserRateLimiter({
  windowMs,
  max,
  keyPrefix,
}: {
  windowMs: number;
  max: number;
  keyPrefix: string;
}): (req: AuthRequest, res: Response, next: NextFunction) => void {
  const durationSeconds = Math.ceil(windowMs / 1000);

  const limiter: RateLimiterRedis | RateLimiterMemory = useRedis
    ? new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix,
        points: max,
        duration: durationSeconds,
      })
    : new RateLimiterMemory({ keyPrefix, points: max, duration: durationSeconds });

  return function userRateLimiterMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction,
  ): void {
    // Prefer authenticated user id; fall back to IP for unauthenticated callers.
    const rawIdentity = req.user?.id ?? req.userId ?? req.ip ?? 'unknown';

    limiter
      .consume(rawIdentity)
      .then((limiterRes) => {
        setRateLimitHeaders(res, limiterRes);
        next();
      })
      .catch((limiterRes) => {
        handleRejection(
          req,
          res,
          limiterRes,
          keyPrefix,
          rawIdentity,
          'Too many booking requests. Please slow down and try again later.',
        );
      });
  };
}

/**
 * Payment attempt limiter middleware.
 *
 * Enforces per-actor and per-booking attempt limits (counted by idempotency
 * key) and consults the provider circuit breaker before any provider call is
 * made. When a limit is hit or a circuit is open, the request is rejected with
 * a truthful 429/503 response and retry guidance instead of generating further
 * provider traffic. In-flight transactions are unaffected and continue to be
 * reconciled by the payment worker.
 *
 * Backpressure signals are exposed via response headers:
 *   - `X-Payment-Backpressure`  : "none" | "elevated" | "saturated"
 *   - `X-Payment-Queue-Depth`   : current queued payment attempts
 *   - `X-Payment-Circuit-State` : "closed" | "open" | "half-open" (per provider)
 */
export function paymentAttemptRateLimiter(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void {
  const actorId = req.user?.id ?? req.userId ?? req.ip ?? 'unknown';
  const bookingId =
    (req.body?.bookingId as string | undefined) ??
    (req.params?.bookingId as string | undefined) ??
    (req.params?.id as string | undefined);
  const idempotencyKey =
    (req.headers['idempotency-key'] as string | undefined) ??
    (req.body?.idempotencyKey as string | undefined);
  const provider = (req.body?.provider as string | undefined) ?? 'default';

  const circuit = paymentCircuitBreaker.getState(provider);
  const backpressure = paymentAttemptLimiter.getBackpressure();

  res.setHeader('X-Payment-Backpressure', backpressure.level);
  res.setHeader('X-Payment-Queue-Depth', String(backpressure.queueDepth));
  res.setHeader('X-Payment-Circuit-State', circuit.state);

  // Open circuit: do not generate provider calls. Defer with retry guidance.
  if (circuit.state === 'open') {
    const retryAfter = Math.max(1, Math.ceil((circuit.retryAfterMs ?? 0) / 1000));
    res.setHeader('Retry-After', String(retryAfter));

    loggingService.logBlockchainOperation(
      'payment_circuit_open',
      { provider, route: req.path, method: req.method, retryAfter },
      undefined,
      'Payment provider circuit is open; request deferred.',
    );

    res.status(503).json({
      error: {
        code: 'PAYMENT_PROVIDER_UNAVAILABLE',
        message:
          'The payment provider is temporarily unavailable. Your request was not processed; please retry later.',
        details: {
          provider,
          circuitState: circuit.state,
          retryAfter,
        },
      },
    });
    return;
  }

  paymentAttemptLimiter
    .consume({ actorId, bookingId, idempotencyKey })
    .then((result: PaymentAttemptLimitResult) => {
      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil(result.msBeforeNext / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Remaining', '0');

        loggingService.logBlockchainOperation(
          'payment_attempt_limit_exceeded',
          {
            scope: result.scope,
            route: req.path,
            method: req.method,
            retryAfter,
          },
          undefined,
          'Payment attempt limit exceeded; request rejected.',
        );

        res.status(429).json({
          error: {
            code: 'PAYMENT_ATTEMPT_LIMIT_EXCEEDED',
            message:
              'Too many payment attempts for this booking. Please wait before retrying.',
            details: {
              scope: result.scope,
              retryAfter,
            },
          },
        });
        return;
      }

      res.setHeader('X-RateLimit-Remaining', String(result.remainingPoints));
      next();
    })
    .catch((err: unknown) => {
      // Fail closed on limiter infrastructure errors to avoid provider storms.
      loggingService.logBlockchainOperation(
        'payment_attempt_limiter_error',
        { route: req.path, method: req.method },
        undefined,
        err instanceof Error ? err.message : 'Payment attempt limiter error',
      );

      res.setHeader('Retry-After', '5');
      res.status(503).json({
        error: {
          code: 'PAYMENT_LIMITER_UNAVAILABLE',
          message:
            'Payment processing is temporarily unavailable. Please retry shortly.',
          details: { retryAfter: 5 },
        },
      });
    });
}

// Backward compatibility export
export const rateLimiter = generalRateLimiter;
