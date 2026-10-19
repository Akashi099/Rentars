import type { Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  getCurrentModerationPolicy,
  getPolicyVersion,
  listPolicyVersions,
} from '../services/moderationPolicy.service.js';

/**
 * GET /api/v1/policy/moderation/current
 * Returns the active moderation policy snapshot (public, unauthenticated).
 */
export async function getCurrentModerationPolicyHandler(_req: Request, res: Response): Promise<void> {
  const result = await getCurrentModerationPolicy();
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
  res.json(result.data);
}

/**
 * GET /api/v1/policy/moderation/versions
 * List all moderation policy versions.  Admin-only.
 */
export async function listPolicyVersionsHandler(_req: AuthRequest, res: Response): Promise<void> {
  const result = await listPolicyVersions();
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * GET /api/v1/policy/moderation/versions/:version
 * Get a specific policy version snapshot.  Admin-only.
 * Used to view the policy in effect when a historical decision was made.
 */
export async function getPolicyVersionHandler(req: Request, res: Response): Promise<void> {
  const result = await getPolicyVersion(req.params.version);
  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
