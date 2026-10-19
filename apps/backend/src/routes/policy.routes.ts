/**
 * Policy routes — unauthenticated endpoints that return versioned platform
 * policy snapshots. Clients read these before confirmation flows so they can
 * display current fees, refund rules, and risk disclosures.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getCurrentPolicySnapshot } from '@/services/platformPolicy.service.js';
import {
  getCurrentModerationPolicyHandler,
  listPolicyVersionsHandler,
  getPolicyVersionHandler,
} from '@/controllers/moderationPolicy.controller.js';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';

const router = Router();

/**
 * GET /api/v1/policy/current
 *
 * Returns the active policy snapshot. Clients should store the returned
 * `version` string and submit it as `terms_version` in the booking payload.
 *
 * @openapi
 * /api/v1/policy/current:
 *   get:
 *     tags: [Policy]
 *     summary: Get current platform policy snapshot
 *     description: |
 *       Returns fees, refund tiers, escrow behaviour, and risk disclosures
 *       that must be displayed to users before they confirm a booking.
 *       The `version` field must be submitted as `terms_version` in the
 *       POST /api/v1/bookings request body.
 *     responses:
 *       200:
 *         description: Current policy snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:        { type: string }
 *                 effectiveDate:  { type: string, format: date }
 *                 platformFeePct: { type: number }
 *                 refundTiers:    { type: array }
 *                 escrow:         { type: object }
 *                 blockchainRisks: { type: array }
 *                 termsUrl:       { type: string }
 *                 privacyUrl:     { type: string }
 */
router.get('/current', (_req: Request, res: Response): void => {
  const snapshot = getCurrentPolicySnapshot();
  // 1-hour public cache — short enough to pick up same-day changes
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.json(snapshot);
});

// ─── Moderation policy ───────────────────────────────────────────────────────
//
// Returns the versioned content moderation policy — reason codes, enforcement
// actions, appeal windows, and retention rules.  The /current endpoint is
// public so the UI can display report reason options without authentication.
// The /versions endpoints are admin-only for audit trail access.

// GET /api/v1/policy/moderation/current — public
router.get('/moderation/current', getCurrentModerationPolicyHandler);

// GET /api/v1/policy/moderation/versions — admin only
router.get('/moderation/versions', authenticate, requireRole('admin'), listPolicyVersionsHandler);

// GET /api/v1/policy/moderation/versions/:version — admin only
router.get('/moderation/versions/:version', authenticate, requireRole('admin'), getPolicyVersionHandler);

export default router;
