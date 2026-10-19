/**
 * Notification Monitor Routes (Admin)
 *
 * Visibility into the notification delivery pipeline.
 * All routes require requireAdminRole + admin:notifications:read scope.
 *
 * GET /api/v1/admin/notifications/metrics    — queue depth, latency, failure rates
 * GET /api/v1/admin/notifications/breakdown  — failures grouped by channel + type
 * GET /api/v1/admin/notifications/backlog    — retry backlog (past-due retries)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdminRole, requireScope } from '../middleware/adminScope.middleware.js';
import {
  getDashboardMetrics,
  getChannelBreakdown,
  getRetryBacklog,
} from '../services/notificationMonitor.service.js';

const router = Router();

router.use(requireAdminRole);

/**
 * GET /api/v1/admin/notifications/metrics
 *
 * Dashboard-level metrics: queue depth, total sent/delivered/failed,
 * overall failure rate, per-channel breakdown, avg latencies.
 *
 * Query params:
 *   window_hours — look-back window in hours (default 24, max 168)
 */
router.get(
  '/metrics',
  requireScope('admin:notifications:read'),
  async (req: Request, res: Response): Promise<void> => {
    const windowHours = Math.min(168, Math.max(1, Number(req.query.window_hours ?? 24)));
    const result = await getDashboardMetrics(windowHours);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data });
  },
);

/**
 * GET /api/v1/admin/notifications/breakdown
 *
 * Failed notification counts grouped by (channel, notification_type, failure_category).
 * Use this to identify which channel + template combination is failing.
 *
 * Query params:
 *   window_hours — look-back window (default 24, max 168)
 */
router.get(
  '/breakdown',
  requireScope('admin:notifications:read'),
  async (req: Request, res: Response): Promise<void> => {
    const windowHours = Math.min(168, Math.max(1, Number(req.query.window_hours ?? 24)));
    const result = await getChannelBreakdown(windowHours);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data, meta: { windowHours } });
  },
);

/**
 * GET /api/v1/admin/notifications/backlog
 *
 * Notification delivery records that are scheduled for retry but have not
 * been picked up yet (next_retry_at is in the past, status = 'queued').
 *
 * Query params:
 *   limit — max rows (default 50, max 200)
 */
router.get(
  '/backlog',
  requireScope('admin:notifications:read'),
  async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    const result = await getRetryBacklog(limit);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data, meta: { limit } });
  },
);

export default router;
