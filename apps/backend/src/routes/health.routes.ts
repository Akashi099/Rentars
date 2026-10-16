import { getRpcHealth } from '@/blockchain/soroban.js';
import { pingRedis } from '@/config/redis.js';
import { supabase } from '@/config/supabase.js';
import { type Request, type Response, Router } from 'express';

const router = Router();

export type HealthStatus = 'ok' | 'error' | 'not_configured';

/**
 * Probe database connectivity. Never throws — resolves to false on failure.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    const { error } = await supabase.from('properties').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Turn a settled probe result into a health status.
 * `null` means the dependency isn't configured; a rejection is treated as a failure.
 */
export function toHealthStatus(result: PromiseSettledResult<boolean | null>): HealthStatus {
  if (result.status === 'rejected') return 'error';
  if (result.value === null) return 'not_configured';
  return result.value ? 'ok' : 'error';
}

/**
 * GET /health — lightweight liveness probe.
 * 
 * Returns 200 if the process is running and can handle HTTP requests.
 * Does NOT check dependencies (database, Redis, RPC) — use /health/ready for that.
 * 
 * Use this for:
 * - Kubernetes livenessProbe
 * - Load balancer health checks that only care if the process is alive
 * - Fast smoke tests immediately after deployment
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'Rentars API 🚀',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready — dependency-aware readiness probe.
 * 
 * Verifies:
 * - Database connectivity and schema compatibility
 * - Redis connectivity (if configured)
 * - Blockchain RPC status (if configured)
 *
 * Each dependency is probed concurrently with a bounded timeout.
 * Returns HTTP 503 if any required dependency is unavailable.
 * 
 * Use this for:
 * - Kubernetes readinessProbe
 * - Post-deploy verification that all dependencies are healthy
 * - Monitoring alerts for degraded service
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  const PROBE_TIMEOUT_MS = 5000;

  const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Probe timeout')), timeoutMs)
      ),
    ]);
  };

  const [databaseResult, redisResult, blockchainResult] = await Promise.allSettled([
    withTimeout(pingDatabase(), PROBE_TIMEOUT_MS),
    process.env.REDIS_URL
      ? withTimeout(pingRedis(), PROBE_TIMEOUT_MS)
      : Promise.resolve(null),
    process.env.STELLAR_RPC_URL
      ? withTimeout(getRpcHealth(), PROBE_TIMEOUT_MS)
      : Promise.resolve(null),
  ]);

  const checks: Record<'database' | 'redis' | 'blockchain', HealthStatus> = {
    database: toHealthStatus(databaseResult),
    redis: toHealthStatus(redisResult),
    blockchain: toHealthStatus(blockchainResult),
  };

  // Database is always required; others are optional
  const notReady = checks.database === 'error' ||
    (process.env.REDIS_URL && checks.redis === 'error');

  res.status(notReady ? 503 : 200).json({
    status: notReady ? 'not_ready' : 'ready',
    service: 'Rentars API 🚀',
    timestamp: new Date().toISOString(),
    checks,
  });
});

export default router;
