/**
 * Database connection budget and query-timeout configuration.
 *
 * API and worker workloads share the same PostgreSQL/Supabase instance, so
 * unbounded connection pools and runaway queries can starve user-facing
 * operations. This module centralises the connection budget, exposes a bounded
 * query wrapper, and instruments slow queries so saturation produces
 * controlled backpressure instead of process collapse.
 */

import { performance } from 'node:perf_hooks';
import {
  incCounter,
  observeHistogram,
  dbQueryDurationSeconds,
  dbSlowQueriesTotal,
} from '@/middleware/metrics.middleware.js';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Maximum simultaneous database connections held by the API process. */
export const DB_POOL_MAX = intEnv('DB_POOL_MAX', 10);

/** Connections reserved for worker/background jobs (sync, retention, reconcile). */
export const DB_POOL_WORKER_MAX = intEnv('DB_POOL_WORKER_MAX', 4);

/** How long a caller waits for a free connection before failing fast. */
export const DB_POOL_ACQUIRE_TIMEOUT_MS = intEnv('DB_POOL_ACQUIRE_TIMEOUT_MS', 5_000);

/** Per-statement server-side timeout (`statement_timeout`). */
export const DB_STATEMENT_TIMEOUT_MS = intEnv('DB_STATEMENT_TIMEOUT_MS', 15_000);

/** Queries slower than this are recorded as slow-query events. */
export const DB_SLOW_QUERY_MS = intEnv('DB_SLOW_QUERY_MS', 500);

/** Maximum rows any single collection query may return. */
export const DB_MAX_PAGE_SIZE = intEnv('DB_MAX_PAGE_SIZE', 100);

export class QueryTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Query "${operation}" exceeded ${timeoutMs}ms timeout`);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Run a database operation under a timeout, recording duration and slow-query
 * metrics. Rejects with QueryTimeoutError when the budget is exceeded so
 * callers can shed load instead of queueing indefinitely.
 */
export async function withQueryTimeout<T>(
  operation: string,
  fn: () => Promise<T>,
  timeoutMs: number = DB_STATEMENT_TIMEOUT_MS,
): Promise<T> {
  const started = performance.now();
  let outcome = 'success';
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueryTimeoutError(operation, timeoutMs)), timeoutMs);
    });
    return await Promise.race([fn(), timeout]);
  } catch (err) {
    outcome = err instanceof QueryTimeoutError ? 'timeout' : 'error';
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    const elapsedMs = performance.now() - started;
    observeHistogram(dbQueryDurationSeconds, { operation, outcome }, elapsedMs / 1000);
    if (elapsedMs > DB_SLOW_QUERY_MS) {
      incCounter(dbSlowQueriesTotal, { operation });
      console.warn(`[db] slow query operation="${operation}" duration=${Math.round(elapsedMs)}ms`);
    }
  }
}

/** Clamp a requested page size to the configured hard ceiling. */
export function clampPageSize(requested: number | undefined, fallback = 20): number {
  const n = Number(requested);
  if (!Number.isFinite(n) || n < 1) return Math.min(fallback, DB_MAX_PAGE_SIZE);
  return Math.min(Math.floor(n), DB_MAX_PAGE_SIZE);
}
