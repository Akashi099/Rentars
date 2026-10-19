/**
 * Redis key namespace and bounds.
 *
 * Redis backs cache, rate limits, queues, and temporary state. To prevent
 * collisions across environments/services and unbounded payloads, every key
 * MUST be built through `redisKey()` and every value MUST stay within
 * `REDIS_MAX_VALUE_BYTES`. TTLs must be positive and are capped by
 * `REDIS_MAX_TTL_SECONDS`.
 *
 * Key shape: `<env>:<service>:<domain>:<...parts>`
 * e.g. `production:rentars:cache:property:abc-123`
 */

function sanitize(part: string): string {
  return String(part).replace(/[\s:]+/g, '_');
}

/** Deployment environment namespace (never collides across envs). */
export const REDIS_ENV = sanitize(process.env.REDIS_ENV ?? process.env.NODE_ENV ?? 'development');

/** Service namespace (allows shared Redis cluster across services). */
export const REDIS_SERVICE = sanitize(process.env.REDIS_SERVICE ?? 'rentars');

/** Absolute prefix for every key written by this service. */
export const REDIS_KEY_PREFIX = `${REDIS_ENV}:${REDIS_SERVICE}`;

/** Maximum serialized value size accepted by cache writes (bytes). */
export const REDIS_MAX_VALUE_BYTES = Number(process.env.REDIS_MAX_VALUE_BYTES ?? 1_048_576);

/** Hard ceiling for any TTL (7 days). Prevents unbounded/never-expiring keys. */
export const REDIS_MAX_TTL_SECONDS = Number(process.env.REDIS_MAX_TTL_SECONDS ?? 604_800);

export type RedisDomain = 'cache' | 'ratelimit' | 'queue' | 'session' | 'temp';

/**
 * Build a fully-namespaced Redis key.
 *
 * @example redisKey('cache', 'property', id) // production:rentars:cache:property:<id>
 */
export function redisKey(domain: RedisDomain, ...parts: (string | number)[]): string {
  return [REDIS_KEY_PREFIX, domain, ...parts.map(sanitize)].join(':');
}

/** Clamp a requested TTL into the allowed (0, REDIS_MAX_TTL_SECONDS] range. */
export function boundedTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`redis: ttl must be a positive number, got ${ttlSeconds}`);
  }
  return Math.min(Math.floor(ttlSeconds), REDIS_MAX_TTL_SECONDS);
}

/**
 * Outage policy (documented, tested):
 *   - cache:     fail-open (miss) — never block user traffic; authorization and
 *                rate protection are enforced independently of the cache.
 *   - ratelimit: fail-closed for security-sensitive routes — see rateLimitStore;
 *                Redis outages must not silently disable throttles.
 *   - queue:     stop dequeuing; jobs are retried once Redis returns.
 *   - session:   reject the request (no silent auth bypass) and surface 503.
 *   - temp:      treated as a miss.
 * Cache/session writes must never bypass authorization.
 */
export const REDIS_OUTAGE_POLICY = {
  cache: 'fail-open',
  ratelimit: 'fail-closed',
  queue: 'pause',
  session: 'reject',
  temp: 'fail-open',
} as const;

/** Assert a serialized payload is within the configured bound. */
export function assertValueSize(serialized: string): void {
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > REDIS_MAX_VALUE_BYTES) {
    throw new Error(`redis: value size ${size}B exceeds limit ${REDIS_MAX_VALUE_BYTES}B`);
  }
}
