/**
 * Block & Abuse Report Routes
 *
 * User-to-user blocking:
 *   POST   /api/v1/blocks/:userId       — block a user
 *   DELETE /api/v1/blocks/:userId       — unblock a user
 *   GET    /api/v1/blocks               — list your blocked users
 *
 * Abuse reports (authenticated users):
 *   POST   /api/v1/abuse-reports        — submit a report
 *   GET    /api/v1/abuse-reports        — admin: list all reports
 *   PATCH  /api/v1/abuse-reports/:id/resolve  — admin: resolve
 *   PATCH  /api/v1/abuse-reports/:id/dismiss  — admin: dismiss
 */

import { Router } from 'express';
import { z } from 'zod';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  blockUser,
  unblockUser,
  getBlockedUserIds,
  createAbuseReport,
  listAbuseReports,
  resolveAbuseReport,
  dismissAbuseReport,
  type AbuseTargetType,
  type AbuseReason,
} from '../services/blockList.service.js';

const router = Router();

// ─── Block endpoints ──────────────────────────────────────────────────────────

/** POST /api/v1/blocks/:userId — block another user */
router.post('/:userId', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const callerId = req.userId;
  if (!callerId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { reason } = req.body as { reason?: string };
  const result = await blockUser(callerId, req.params.userId, reason);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ message: 'User blocked', data: result.data });
});

/** DELETE /api/v1/blocks/:userId — unblock a user */
router.delete('/:userId', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const callerId = req.userId;
  if (!callerId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await unblockUser(callerId, req.params.userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ message: 'User unblocked' });
});

/** GET /api/v1/blocks — list users the caller has blocked */
router.get('/', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const callerId = req.userId;
  if (!callerId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await getBlockedUserIds(callerId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ data: result.data });
});

// ─── Abuse report endpoints ───────────────────────────────────────────────────

const createReportSchema = z.object({
  target_type: z.enum(['message', 'review', 'notification', 'user']),
  target_id: z.string().min(1, 'target_id is required'),
  reason: z.enum([
    'spam', 'harassment', 'hate_speech', 'phishing',
    'unsafe_link', 'impersonation', 'inappropriate_content', 'other',
  ]),
  detail: z.string().max(1_000).optional(),
});

/** POST /api/v1/abuse-reports — submit an abuse report */
router.post('/abuse-reports', authenticate, async (req: AuthRequest, res: Response): Promise<void> => {
  const callerId = req.userId;
  if (!callerId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = createReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { target_type, target_id, reason, detail } = parsed.data;
  const result = await createAbuseReport(
    callerId,
    target_type as AbuseTargetType,
    target_id,
    reason as AbuseReason,
    detail,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ message: 'Report submitted', data: result.data });
});

/** GET /api/v1/abuse-reports — admin: list abuse reports */
router.get('/abuse-reports', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20)));
  const status = req.query.status as string | undefined;
  const targetType = req.query.target_type as string | undefined;

  const result = await listAbuseReports({
    page,
    limit,
    status: status as Parameters<typeof listAbuseReports>[0]['status'],
    targetType: targetType as Parameters<typeof listAbuseReports>[0]['targetType'],
  });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ data: result.data?.data, meta: { page, limit, total: result.data?.total } });
});

/** PATCH /api/v1/abuse-reports/:id/resolve — admin: resolve a report */
router.patch('/abuse-reports/:id/resolve', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  const resolverId = req.userId;
  if (!resolverId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { resolution_note } = req.body as { resolution_note?: string };
  const result = await resolveAbuseReport(req.params.id, resolverId, resolution_note);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ message: 'Report resolved', data: result.data });
});

/** PATCH /api/v1/abuse-reports/:id/dismiss — admin: dismiss a report */
router.patch('/abuse-reports/:id/dismiss', authenticate, requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  const resolverId = req.userId;
  if (!resolverId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { note } = req.body as { note?: string };
  const result = await dismissAbuseReport(req.params.id, resolverId, note);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ message: 'Report dismissed', data: result.data });
});

export default router;
