/**
 * Application entry point.
 *
 * dotenv is loaded before anything else so env vars are available when
 * config/env.ts runs its startup validation.  If any required variables are
 * missing or invalid, env.ts calls process.exit(1) with a full error report.
 *
 * Middleware order is intentional:
 *   1. securityMiddleware      — Helmet headers on every response, including errors
 *   2. corsMiddleware          — CORS preflight resolved before any auth/body parsing
 *   3. requestIdMiddleware     — injects X-Request-Id before any logging happens
 *   4. tracingMiddleware       — extracts/injects W3C trace context
 *   5. body parsers            — JSON / multipart
 *   6. rateLimiter             — reject abusive traffic before heavy processing
 *   7. timeoutMiddleware       — bound long-running handlers
 *   8. requestLoggingMiddleware — structured per-request log on response finish
 *   9. metricsMiddleware       — record latency / counts on response finish
 *  10. metricsRouter           — /metrics scrape endpoint (before app routes)
 *  11. routes                  — application routes
 *  12. errorMiddleware         — structured error logging + error responses
 */

import 'dotenv/config'; // must be first import
import { env } from './config/env.js';
import express from 'express';
import cookieParser from 'cookie-parser';

// ── Observability & security middleware ───────────────────────────────────────
import { securityMiddleware } from './middleware/security.middleware.js';
import { corsMiddleware } from './middleware/cors.middleware.js';
import { csrfMiddleware, csrfTokenMiddleware } from './middleware/csrf.middleware.js';
import {
  requestIdMiddleware,
  requestLoggingMiddleware,
  structuredLog,
} from './middleware/logging.middleware.js';
import { metricsMiddleware, metricsRouter } from './middleware/metrics.middleware.js';
import { errorMiddleware } from './middleware/error.middleware.js';
import { tracingMiddleware } from './middleware/tracing.middleware.js';

// ── Core middleware ───────────────────────────────────────────────────────────
import { rateLimiter } from './middleware/rateLimiter.js';
import { sessionRevocationGuard } from './middleware/sessionRevocation.middleware.js';
import { parseTrustProxy } from './utils/trustProxy.js';
import { timeoutMiddleware } from './middleware/timeout.middleware.js';

// ── Routes & services ─────────────────────────────────────────────────────────
import routes from './routes/index.js';
import { setupOpenApiRoutes } from './config/swagger.js';
import { validateBlockchainConfig } from './blockchain/config.js';
import { startSyncScheduler } from './services/cleanup-schedular.js';
import { startRateRefreshLoop } from './services/exchangeRate.service.js';
import { startProbeScheduler, stopProbeScheduler } from './services/probe-scheduler.js';

// ── Validate blockchain config early (before the server binds) ────────────────
const configErrors = validateBlockchainConfig();
if (configErrors.length > 0) {
  const errorDetails = configErrors
    .map((err) => `  - ${err.field}: ${err.message}`)
    .join('\n');
  structuredLog({
    level: 'error',
    message: 'Blockchain configuration validation failed',
    timestamp: new Date().toISOString(),
    details: errorDetails,
  });
  process.exit(1);
}

export const app = express();

// Resolve req.ip from X-Forwarded-For only for the hops in TRUST_PROXY. Without
// this, every client behind a reverse proxy shares one rate-limit bucket.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// ── 1. Security headers (must be first — applies to every response) ───────────
app.use(securityMiddleware);

// ── 2. CORS (resolved before body parsing and auth) ──────────────────────────
app.use(corsMiddleware);

// ── 3. Request-ID injection ───────────────────────────────────────────────────
app.use(requestIdMiddleware);

// ── 4. Cookie parsing (required for CSRF middleware) ───────────────────────────
app.use(cookieParser());

// ── 5. Body parsers ───────────────────────────────────────────────────────────
const JSON_BODY_LIMIT = env.JSON_BODY_LIMIT;
app.use((req, res, next) => {
  // Skip JSON parsing for multipart requests — multer handles those.
  if (req.is('multipart/form-data')) return next();
  express.json({ limit: JSON_BODY_LIMIT })(req, res, next);
});

// ── 6. CSRF token generation (for safe GET/HEAD/OPTIONS requests) ──────────────
app.use(csrfTokenMiddleware);

// ── 7. CSRF token validation (for state-changing requests) ────────────────────
app.use(csrfMiddleware);

// ── 8. Rate limiting ──────────────────────────────────────────────────────────
app.use(rateLimiter);

// ── 8b. Session revocation guard (rejects tokens issued before a password reset / logout-all) ──
app.use(sessionRevocationGuard);

// ── 9. Request timeout ────────────────────────────────────────────────────────
app.use(timeoutMiddleware);

// ── 10. Structured request logging ─────────────────────────────────────────────
app.use(requestLoggingMiddleware);

// ── 11. Metrics collection (must be before routes to record all requests) ──────
app.use(metricsMiddleware);

// ── 12. /metrics scrape endpoint ───────────────────────────────────────────────
app.use(metricsRouter);

// ── 13. Application routes ────────────────────────────────────────────────────
app.use(routes);

// ── OpenAPI / Swagger UI docs ─────────────────────────────────────────────────
setupOpenApiRoutes(app);

// ── 14. Centralised error handler ─────────────────────────────────────────────
app.use(errorMiddleware);

// ── Server startup ────────────────────────────────────────────────────────────

const PORT = env.PORT;
const GRACE_SHUTDOWN_TIMEOUT = parseInt(
  process.env.GRACE_SHUTDOWN_TIMEOUT_MS ?? '30000',
  10,
);

async function startServer(): Promise<void> {
  const server = app.listen(PORT, () => {
    structuredLog({
      level: 'info',
      message: `Rentars API listening`,
      timestamp: new Date().toISOString(),
      port: PORT,
      nodeEnv: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
    });
    startSyncScheduler();
    startRateRefreshLoop();
    startProbeScheduler();
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  function gracefulShutdown(signal: string): void {
    structuredLog({
      level: 'info',
      message: `Received ${signal}, starting graceful shutdown`,
      timestamp: new Date().toISOString(),
      signal,
    });

    stopProbeScheduler();

    server.close(() => {
      structuredLog({
        level: 'info',
        message: 'HTTP server closed',
        timestamp: new Date().toISOString(),
      });
      process.exit(0);
    });

    const shutdownTimer = setTimeout(() => {
      structuredLog({
        level: 'error',
        message: 'Forced shutdown after timeout',
        timestamp: new Date().toISOString(),
        timeoutMs: GRACE_SHUTDOWN_TIMEOUT,
      });
      process.exit(1);
    }, GRACE_SHUTDOWN_TIMEOUT);

    shutdownTimer.unref();
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => gracefulShutdown(signal));
  }

  process.on('uncaughtException', (error) => {
    structuredLog({
      level: 'error',
      message: 'Uncaught exception',
      timestamp: new Date().toISOString(),
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    structuredLog({
      level: 'error',
      message: 'Unhandled promise rejection',
      timestamp: new Date().toISOString(),
      reason: String(reason),
    });
    process.exit(1);
  });
}

startServer().catch((error) => {
  structuredLog({
    level: 'error',
    message: 'Fatal startup error',
    timestamp: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
