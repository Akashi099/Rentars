import type { Request, Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import {
  submitReview,
  getReviewsForProperty,
  getReviewsForUser,
  getAverageRating,
  addHostResponse,
  flagReview,
  reportReview as serviceReportReview,
  startModeration,
  takeModerationAction,
  submitAppeal,
  resolveAppeal,
  moderateReview,
  getFlaggedReviews,
  approveReview,
  rejectReview,
  getPendingReviews,
  getModerationQueue,
  getPendingAppeals,
} from '../services/review.service.js';
import {
  getReviewRepairQueue,
  reconcileAllReviews,
  resolveRepairTask,
} from '../services/reviewSync.service.js';

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
    res.status(isOwnershipError ? 403 : 400).json({ error: result.error });
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

/**
 * POST /api/v1/reviews/:id/report
 * Structured report with a policy reason code.
 */
export async function reportReviewStructured(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { reasonCode, details } = req.body;
  if (!reasonCode || typeof reasonCode !== 'string') {
    res.status(400).json({ error: 'reasonCode is required' });
    return;
  }
  const result = await serviceReportReview(req.params.id, userId, reasonCode, details);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json({ message: 'Review reported', review: result.data });
}

/**
 * PATCH /api/v1/reviews/:id/moderation/start
 * Start moderation review on a reported review.  Admin-only.
 */
export async function startModerationHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const result = await startModeration(req.params.id, moderatorId);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * POST /api/v1/reviews/:id/moderation-action
 * Take a moderation action (hide/remove/keep) with a policy code.  Admin-only.
 */
export async function moderationActionHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { action, policyVersion, policyCode, explanation } = req.body;
  const result = await takeModerationAction(
    req.params.id,
    moderatorId,
    action,
    policyVersion,
    policyCode,
    explanation,
  );
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * POST /api/v1/reviews/:id/appeal
 * Submit an appeal for a moderation decision.  Only the review author can appeal.
 */
export async function submitAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  const appellantId = req.userId;
  if (!appellantId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { reason } = req.body;
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    res.status(400).json({ error: 'reason is required' });
    return;
  }
  const result = await submitAppeal(req.params.id, appellantId, reason);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * PATCH /api/v1/reviews/:id/appeal/resolve
 * Resolve a pending appeal.  Admin-only.
 */
export async function resolveAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { approved } = req.body;
  if (typeof approved !== 'boolean') {
    res.status(400).json({ error: 'approved (boolean) is required' });
    return;
  }
  const result = await resolveAppeal(req.params.id, moderatorId, approved);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
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

/**
 * GET /api/v1/reviews/moderation/queue
 * List reviews in the moderation queue (reported, under_review, appealed, action_taken).
 */
export async function listModerationQueue(_req: Request, res: Response): Promise<void> {
  const result = await getModerationQueue();
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * GET /api/v1/reviews/moderation/appeals
 * List reviews with pending appeals.
 */
export async function listPendingAppeals(_req: Request, res: Response): Promise<void> {
  const result = await getPendingAppeals();
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
  const { reason, policyVersion, policyCode, explanation } = req.body;
  if (!reason || typeof reason !== 'string') {
    res.status(400).json({ error: 'reason (string) is required' });
    return;
  }
  const result = await rejectReview(req.params.id, reason, req.userId, policyVersion, policyCode, explanation);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Review sync / repair queue ──────────────────────────────────────────────

/**
 * GET /api/v1/reviews/sync/repair-queue
 * List repair queue tasks.  Admin-only.
 */
export async function getRepairQueueHandler(req: AuthRequest, res: Response): Promise<void> {
  const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
  const result = await getReviewRepairQueue(
    statusParam as 'open' | 'in_progress' | 'resolved' | 'wont_fix' | undefined,
  );
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * POST /api/v1/reviews/sync/reconcile
 * Trigger reconciliation of all reviews needing attention.  Admin-only.
 */
export async function reconcileReviewsHandler(_req: AuthRequest, res: Response): Promise<void> {
  const result = await reconcileAllReviews();
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

/**
 * POST /api/v1/reviews/sync/repair/:id/resolve
 * Resolve a repair queue task.  Admin-only.
 */
export async function resolveRepairTaskHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { resolutionNote, wontFix } = req.body;
  if (!resolutionNote || typeof resolutionNote !== 'string' || !resolutionNote.trim()) {
    res.status(400).json({ error: 'resolutionNote is required' });
    return;
  }
  const result = await resolveRepairTask(req.params.id, moderatorId, resolutionNote, wontFix);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}
