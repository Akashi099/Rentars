import type { Request, Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import {
  getProfile,
  getPublicProfile,
  updateProfile,
  updateStellarAddress,
  computeProfileCompleteness,
} from '@/services/profile.service.js';

export async function getOwnProfileHandler(req: AuthRequest, res: Response): Promise<void> {
  const result = await getProfile(req.userId!);
  if (!result.success || !result.data) {
    res.status(404).json({ error: result.error });
    return;
  }
  const completeness = computeProfileCompleteness(result.data);
  res.json({ ...result.data, completeness });
}

export async function getPublicProfileHandler(req: Request, res: Response): Promise<void> {
  const result = await getPublicProfile(req.params.id);
  if (!result.success || !result.data) {
    res.status(404).json({ error: result.error });
    return;
  }
  // Public view only: no completeness, since it would reveal which private fields are empty (#918).
  res.json(result.data);
}

export async function updateProfileHandler(req: AuthRequest, res: Response): Promise<void> {
  const { expected_updated_at: expectedUpdatedAt, ...fields } = req.body as Record<string, unknown>;
  const result = await updateProfile(req.userId!, fields, {
    expectedUpdatedAt: typeof expectedUpdatedAt === 'string' ? expectedUpdatedAt : undefined,
  });

  if (!result.success) {
    if (result.errorCode === 'CONFLICT') {
      // Return the canonical current profile so the client can merge without losing data.
      res.status(409).json({ error: result.error, code: 'PROFILE_CONFLICT', current: result.current });
      return;
    }
    if (result.errorCode === 'NOT_FOUND') {
      res.status(404).json({ error: result.error });
      return;
    }
    res.status(400).json({ error: result.error });
    return;
  }

  if (typeof fields.stellar_address === 'string' || fields.stellar_address === null) {
    await auditLogger.log({
      actorId: req.userId,
      action: 'account.wallet_link',
      resourceType: 'account',
      resourceId: req.userId,
      ip: req.ip,
      success: true,
      meta: { stellar_address: fields.stellar_address, via: 'profile_patch' },
    });
  }

  res.json(result.data);
}

export async function updateStellarAddressHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const { stellar_address } = req.body;
  if (!stellar_address) {
    res.status(400).json({ error: 'stellar_address is required' });
    return;
  }
  const result = await updateStellarAddress(req.userId!, stellar_address);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  await auditLogger.log({
    actorId: req.userId,
    action: 'account.wallet_link',
    resourceType: 'account',
    resourceId: req.userId,
    ip: req.ip,
    success: true,
    meta: { stellar_address },
  });

  res.json(result.data);
}
