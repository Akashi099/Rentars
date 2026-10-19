import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  createReview,
  getPropertyReviews,
  getUserReviews,
  getUserAverageRating,
  respondToReview,
  reportReview,
  reportReviewStructured,
  startModerationHandler,
  moderationActionHandler,
  submitAppealHandler,
  resolveAppealHandler,
  moderateReviewHandler,
  listFlaggedReviews,
  listPendingReviews,
  listModerationQueue,
  listPendingAppeals,
  approveReviewHandler,
  rejectReviewHandler,
  getReviewResponseHistory,
  moderateHostResponseHandler,
} from '../controllers/review.controller.js';
import { validateBody } from '../validators/booking.validator.js';
import {
  createReviewSchema,
  flagReviewSchema,
  reportReviewSchema,
  submitAppealSchema,
  resolveAppealSchema,
  moderationActionSchema,
  rejectReviewSchema,
  resolveRepairTaskSchema,
} from '../validators/review.validator.js';
import { validatePagination } from '../validators/pagination.validator.js';

const router = Router();

// POST /api/v1/reviews
router.post('/', authenticate, validateBody(createReviewSchema), createReview);

// GET /api/v1/reviews/property/:id
router.get('/property/:id', validatePagination, getPropertyReviews);

// GET /api/v1/reviews/user/:id
router.get('/user/:id', validatePagination, getUserReviews);

// GET /api/v1/reviews/user/:id/average
router.get('/user/:id/average', getUserAverageRating);

// POST /api/reviews/:id/response — host creates or edits their response
router.post('/:id/response', authenticate, respondToReview);

// GET /api/reviews/:id/response/history — admin: full edit history
router.get('/:id/response/history', authenticate, requireRole('admin'), getReviewResponseHistory);

// PATCH /api/reviews/:id/response/moderate — admin/moderator: approve, reject, or remove
router.patch('/:id/response/moderate', authenticate, requireRole('admin'), moderateHostResponseHandler);

// POST /api/reviews/:id/flag — report a review for moderation
router.post('/:id/flag', authenticate, validateBody(flagReviewSchema), reportReview);

// GET /api/reviews/moderation/flagged — list flagged reviews (admin)
router.get('/moderation/flagged', authenticate, requireRole('admin'), listFlaggedReviews);

// GET /api/v1/reviews/moderation/pending — list pending reviews (admin)
router.get('/moderation/pending', authenticate, requireRole('admin'), listPendingReviews);

// GET /api/v1/reviews/moderation/queue — moderation queue (admin)
router.get('/moderation/queue', authenticate, requireRole('admin'), listModerationQueue);

// GET /api/v1/reviews/moderation/appeals — pending appeals (admin)
router.get('/moderation/appeals', authenticate, requireRole('admin'), listPendingAppeals);

// ─── Sync / repair queue routes (admin) ──────────────────────────────────────

// GET /api/v1/reviews/sync/repair-queue — list repair queue tasks (admin)
router.get('/sync/repair-queue', authenticate, requireRole('admin'), getRepairQueueHandler);

// POST /api/v1/reviews/sync/reconcile — trigger reconciliation (admin)
router.post('/sync/reconcile', authenticate, requireRole('admin'), reconcileReviewsHandler);

// POST /api/v1/reviews/sync/repair/:id/resolve — resolve repair task (admin)
router.post('/sync/repair/:id/resolve', authenticate, requireRole('admin'), validateBody(resolveRepairTaskSchema), resolveRepairTaskHandler);

// ─── Per-review routes ─────────────────────────────────────────────────────────

// POST /api/v1/reviews/:id/response — host replies to a review
router.post('/:id/response', authenticate, respondToReview);

// POST /api/v1/reviews/:id/flag — legacy flag a review for moderation
router.post('/:id/flag', authenticate, validateBody(flagReviewSchema), reportReview);

// POST /api/v1/reviews/:id/report — structured report with policy reason code
router.post('/:id/report', authenticate, validateBody(reportReviewSchema), reportReviewStructured);

// PATCH /api/v1/reviews/:id/moderate — approve or reject (admin)
router.patch('/:id/moderate', authenticate, requireRole('admin'), moderateReviewHandler);

// POST /api/v1/reviews/:id/approve — approve a review (admin)
router.post('/:id/approve', authenticate, requireRole('admin'), approveReviewHandler);

// POST /api/v1/reviews/:id/reject — reject with reason and policy (admin)
router.post('/:id/reject', authenticate, requireRole('admin'), validateBody(rejectReviewSchema), rejectReviewHandler);

// PATCH /api/v1/reviews/:id/moderation/start — start moderation review (admin)
router.patch('/:id/moderation/start', authenticate, requireRole('admin'), startModerationHandler);

// POST /api/v1/reviews/:id/moderation-action — hide/remove/keep (admin)
router.post('/:id/moderation-action', authenticate, requireRole('admin'), validateBody(moderationActionSchema), moderationActionHandler);

// POST /api/v1/reviews/:id/appeal — submit appeal (reviewer only)
router.post('/:id/appeal', authenticate, validateBody(submitAppealSchema), submitAppealHandler);

// PATCH /api/v1/reviews/:id/appeal/resolve — resolve appeal (admin)
router.patch('/:id/appeal/resolve', authenticate, requireRole('admin'), validateBody(resolveAppealSchema), resolveAppealHandler);

export default router;
