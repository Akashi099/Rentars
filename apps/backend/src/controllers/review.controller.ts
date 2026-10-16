import type { Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  submitReview,
  getReviewsForProperty,
  getReviewsForUser,
  getAverageRating,
  addHostResponse,
  flagReview,
  moderateReview,
  getFlaggedReviews,
  approveReview,
  rejectReview,
  getPendingReviews,
  moderateHostResponse,
  getResponseHistory,
} from '../services/review.service.js';

export async function createReview(req: AuthRequest, res: Response): Promise<void> {
  const { bookingId, targetId, rating, comment, propertyId } = req.body;
  const reviewerId = req.userId;

  if (!reviewerId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const result = await submitReview(bookingId, reviewerId, targetId, rating, comment, propertyId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
}

export async function getPropertyReviews(req: Request, res: Response): Promise<void> {
  const pagination = (req as Request & { parsedPagination?: { page: number; pageSize: number } }).parsedPagination;
  const result = await getReviewsForProperty(req.params.id, pagination?.page ?? 1, pagination?.pageSize ?? 20);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getUserReviews(req: Request, res: Response): Promise<void> {
  const pagination = (req as Request & { parsedPagination?: { page: number; pageSize: number } }).parsedPagination;
  const result = await getReviewsForUser(req.params.id, pagination?.page ?? 1, pagination?.pageSize ?? 20);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getUserAverageRating(req: Request, res: Response): Promise<void> {
  const result = await getAverageRating(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ average: result.data });
}

export async function respondToReview(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { response } = req.body;
  if (!response || typeof response !== 'string' || !response.trim()) {
    res.status(400).json({ error: 'response is required' });
    return;
  }
  if (response.trim().length > 1000) {
    res.status(400).json({ error: 'Response must be at most 1000 characters' });
    return;
  }
  const result = await addHostResponse(req.params.id, hostId, response.trim());
  if (!result.success) {
    const isOwnershipError =
      result.error === 'Only the property owner can respond to this review' ||
      result.error === 'Only the reviewed host can respond';
    const isEditWindowError = result.error?.includes('edit') || result.error?.includes('removed');
    res.status(isOwnershipError ? 403 : isEditWindowError ? 422 : 400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/** GET /api/reviews/:id/response/history — admin: full edit history for a response */
export async function getReviewResponseHistory(req: AuthRequest, res: Response): Promise<void> {
  const result = await getResponseHistory(req.params.id);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ data: result.data });
}

/** PATCH /api/reviews/:id/response/moderate — admin: approve/reject/remove a host response */
export async function moderateHostResponseHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { status, note } = req.body as { status?: string; note?: string };
  if (!status || !['approved', 'rejected', 'removed'].includes(status)) {
    res.status(400).json({ error: 'status must be one of: approved, rejected, removed' });
    return;
  }

  const result = await moderateHostResponse(
    req.params.id,
    status as 'approved' | 'rejected' | 'removed',
    moderatorId,
    note,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function reportReview(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    res.status(400).json({ error: 'Flag reason is required' });
    return;
  }
  const result = await flagReview(req.params.id, userId, reason);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ message: 'Review reported for moderation' });
}

export async function moderateReviewHandler(req: AuthRequest, res: Response): Promise<void> {
  const { approve } = req.body;
  if (typeof approve !== 'boolean') {
    res.status(400).json({ error: 'approve (boolean) is required' });
    return;
  }
  const result = await moderateReview(req.params.id, approve, req.userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function listFlaggedReviews(_req: Request, res: Response): Promise<void> {
  const result = await getFlaggedReviews();
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function listPendingReviews(_req: Request, res: Response): Promise<void> {
  const result = await getPendingReviews();
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function approveReviewHandler(req: AuthRequest, res: Response): Promise<void> {
  const result = await approveReview(req.params.id, req.userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function rejectReviewHandler(req: AuthRequest, res: Response): Promise<void> {
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string') {
    res.status(400).json({ error: 'reason (string) is required' });
    return;
  }
  const result = await rejectReview(req.params.id, reason, req.userId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
