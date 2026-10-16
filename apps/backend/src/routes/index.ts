import { autoDeprecationHeaders } from '@/middleware/deprecation.middleware.js';
import { type Request, type Response, Router } from 'express';
import adminRoutes from './admin.routes.js';
import authRoutes from './auth.routes.js';
import bookingRoutes from './booking.routes.js';
import calendarFeedRoutes from './calendarFeed.routes.js';
import clientErrorRoutes from './clientError.routes.js';
import exchangeRateRoutes from './exchangeRate.routes.js';
import followRoutes from './follow.routes.js';
import healthRoutes from './health.routes.js';
import readinessRoutes from './readiness.routes.js';
import hostRoutes from './host.routes.js';
import locationRoutes from './location.routes.js';
import notificationRoutes from './notification.routes.js';
import paymentRoutes from './payment.routes.js';
import probeRoutes from './probe.routes.js';
import propertyRoutes from './property.routes.js';
import pushRoutes from './push.routes.js';
import reviewRoutes from './review.routes.js';
import savedSearchRoutes from './savedSearch.routes.js';
import policyRoutes from './policy.routes.js';
import privacyRoutes from './privacy.routes.js';
import supportRoutes from './support.routes.js';

const router = Router();

// ── Health Check ──────────────────────────────────────────────────────────────
//
// Lives at /health (no version prefix) so infrastructure probes (load
// balancers, Kubernetes liveness checks) never need to track the API version.
// See ./health.routes.ts for the check implementation.

router.use(healthRoutes);

// ── API v1 Routes ─────────────────────────────────────────────────────────────
//
// All public-facing application routes live under /api/v1.
// The autoDeprecationHeaders middleware runs first on every v1 request and
// injects Deprecation/Sunset headers for any endpoint listed in the registry
// (apps/backend/src/middleware/deprecation.middleware.ts).

const apiV1 = Router();

// Inject Deprecation/Sunset headers for registered deprecated endpoints.
apiV1.use(autoDeprecationHeaders);

// Mount all route modules under /api/v1
apiV1.use('/auth', authRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/client-errors', clientErrorRoutes);
apiV1.use('/bookings', bookingRoutes);
apiV1.use('/calendar', calendarFeedRoutes);
apiV1.use('/follows', followRoutes);
apiV1.use('/host', hostRoutes);
apiV1.use('/properties', propertyRoutes);
apiV1.use('/locations', locationRoutes);
apiV1.use('/reviews', reviewRoutes);
apiV1.use('/notifications', notificationRoutes);
apiV1.use('/payments', paymentRoutes);
apiV1.use('/push', pushRoutes);
apiV1.use('/probes', probeRoutes);
apiV1.use('/exchange-rates', exchangeRateRoutes);
apiV1.use('/saved-searches', savedSearchRoutes);
apiV1.use('/policy', policyRoutes);
apiV1.use('/privacy', privacyRoutes);
apiV1.use('/support/cases', supportRoutes);
apiV1.use(readinessRoutes);

router.use('/api/v1', apiV1);

// ── API v2 (future) ───────────────────────────────────────────────────────────
//
// When breaking changes are needed, introduce a new router here and mount it
// at /api/v2.  v1 continues to run alongside it during the deprecation window.
//
// Steps to introduce v2:
//   1. Create apps/backend/src/routes/v2/ with the new route modules.
//   2. Import and mount them on `apiV2` below.
//   3. Mark any superseded v1 endpoints as deprecated in DEPRECATED_ENDPOINTS
//      (deprecation.middleware.ts) with an appropriate Sunset date.
//   4. After the Sunset date has passed and traffic to the v1 endpoint is
//      confirmed to be zero, remove the v1 handler and the registry entry.
//
// See docs/api-versioning.md for the full policy.

const apiV2 = Router();

/**
 * GET /api/v2
 *
 * Placeholder that confirms v2 routing is wired correctly.
 * Replace this with real route modules as v2 endpoints are defined.
 */
apiV2.get('/', (_req: Request, res: Response) => {
  res.json({
    version: 'v2',
    status: 'coming_soon',
    message:
      'API v2 is not yet available. Please continue using /api/v1. ' +
      'See /docs for the versioning policy.',
  });
});

router.use('/api/v2', apiV2);

export default router;
