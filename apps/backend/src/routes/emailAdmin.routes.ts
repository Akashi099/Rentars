/**
 * Email Admin Routes
 *
 * Admin endpoints for email delivery visibility.
 * All routes require requireAdminRole + admin:email:read scope.
 *
 * GET  /api/v1/admin/email/failures          — recent failed/bounced/complaint records
 * GET  /api/v1/admin/email/stats             — delivery status counts over a time window
 * GET  /api/v1/admin/email/suppression       — suppression list
 * POST /api/v1/admin/email/suppression       — manually suppress an address
 * DELETE /api/v1/admin/email/suppression/:email — lift a suppression
 */

import { Router } from 'express';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { requireAdminRole, requireScope } from '../middleware/adminScope.middleware.js';
import {
  getRecentFailures,
  getDeliveryStats,
  getSuppressionList,
  suppressEmail,
  liftSuppression,
  type SuppressionReason,
} from '../services/emailDelivery.service.js';

const router = Router();

router.use(requireAdminRole);

// ── Recent failures ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/email/failures
 *
 * Returns the most recent failed, bounced, or complaint delivery records.
 * Recipient hashes are included; raw addresses are NOT surfaced here.
 *
 * Query params:
 *   limit — max rows to return (default 50, max 200)
 */
router.get(
  '/failures',
  requireScope('admin:email:read'),
  async (_req: Request, res: Response): Promise<void> => {
    const limit = Math.min(200, Math.max(1, Number(_req.query.limit ?? 50)));
    const result = await getRecentFailures(limit);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data, meta: { limit } });
  },
);

// ── Delivery stats ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/email/stats
 *
 * Returns counts by status (queued, sent, delivered, bounced, complaint,
 * failed, suppressed) over the last N hours.
 *
 * Query params:
 *   window_hours — look-back window in hours (default 24, max 168 = 7 days)
 */
router.get(
  '/stats',
  requireScope('admin:email:read'),
  async (req: Request, res: Response): Promise<void> => {
    const windowHours = Math.min(168, Math.max(1, Number(req.query.window_hours ?? 24)));
    const result = await getDeliveryStats(windowHours);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data, meta: { windowHours } });
  },
);

// ── Suppression list ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/email/suppression
 *
 * Lists suppressed email addresses with reasons.
 *
 * Query params:
 *   limit — max rows (default 20, max 200)
 */
router.get(
  '/suppression',
  requireScope('admin:email:read'),
  async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 20)));
    const result = await getSuppressionList(limit);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ data: result.data?.entries, meta: { total: result.data?.total, limit } });
  },
);

const suppressSchema = z.object({
  email: z.string().email('email must be a valid email address'),
  reason: z.enum(['hard_bounce', 'complaint', 'manual', 'unsubscribe']),
  templates: z.array(z.string()).nullable().default(null),
  notes: z.string().max(500).optional(),
  expires_at: z.string().datetime().nullable().optional(),
});

/**
 * POST /api/v1/admin/email/suppression
 *
 * Manually suppress an email address.
 * Body: { email, reason, templates?, notes?, expires_at? }
 */
router.post(
  '/suppression',
  requireScope('admin:email:read'),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = suppressSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      return;
    }

    const { email, reason, templates, notes, expires_at } = parsed.data;
    const result = await suppressEmail(
      email,
      reason as SuppressionReason,
      null,
      templates,
      notes,
      expires_at ?? null,
    );

    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.status(201).json({ message: `${email} added to suppression list` });
  },
);

/**
 * DELETE /api/v1/admin/email/suppression/:email
 *
 * Lift a suppression for the given email address.
 * The email address is URL-encoded in the path parameter.
 */
router.delete(
  '/suppression/:email',
  requireScope('admin:email:read'),
  async (req: Request, res: Response): Promise<void> => {
    const email = decodeURIComponent(req.params.email);
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Invalid email address in path' });
      return;
    }

    const result = await liftSuppression(email);
    if (!result.success) {
      res.status(500).json({ error: result.error });
      return;
    }
    res.json({ message: `Suppression lifted for ${email}` });
  },
);

export default router;
