import type { AdminRequest } from '@/middleware/adminScope.middleware.js';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  addPropertyImage,
  getOwnerPropertyImages,
  getPropertyImages,
  moderatePropertyImage,
  removePropertyImage,
  reorderPropertyImages,
  setPrimaryImage,
} from '@/services/propertyImage.service.js';
import type { Response } from 'express';

export async function uploadImage(req: AuthRequest, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const result = await addPropertyImage(req.params.id, req.userId!, req.file);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

/** Public: approved images only. */
export async function listImages(req: AuthRequest, res: Response): Promise<void> {
  const result = await getPropertyImages(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** Owner: all non-removed images, including pending and rejected with the moderation reason. */
export async function listOwnerImages(req: AuthRequest, res: Response): Promise<void> {
  const result = await getOwnerPropertyImages(req.params.id, req.userId!);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** Admin: POST /api/v1/admin/properties/:id/images/:imageId/moderation  body: { decision, reason? } */
export async function moderateImage(req: AdminRequest, res: Response): Promise<void> {
  const { decision, reason } = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
  if (
    typeof decision !== 'string' ||
    (reason !== undefined && reason !== null && typeof reason !== 'string')
  ) {
    res
      .status(400)
      .json({ error: 'decision must be a string and reason, when given, must be a string' });
    return;
  }

  const result = await moderatePropertyImage({
    propertyId: req.params.id,
    imageId: req.params.imageId,
    actorId: req.adminId!,
    decision,
    reason: reason as string | undefined,
  });
  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function deleteImage(req: AuthRequest, res: Response): Promise<void> {
  const result = await removePropertyImage(req.params.id, req.params.imageId, req.userId!);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 404).json({ error: result.error });
    return;
  }
  res.status(204).send();
}

export async function setAsPrimary(req: AuthRequest, res: Response): Promise<void> {
  const result = await setPrimaryImage(req.params.id, req.params.imageId, req.userId!);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function reorderImages(req: AuthRequest, res: Response): Promise<void> {
  const { orderedIds } = req.body as { orderedIds?: unknown };
  if (!Array.isArray(orderedIds) || orderedIds.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'orderedIds must be an array of image ID strings' });
    return;
  }

  const result = await reorderPropertyImages(req.params.id, req.userId!, orderedIds as string[]);
  if (!result.success) {
    res.status(result.error?.startsWith('Forbidden') ? 403 : 400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
