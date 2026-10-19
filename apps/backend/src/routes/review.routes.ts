import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware.js';
import {
  createReview,
  getPropertyReviews,
  getUserReviews,
  getUserAverageRating,
  respondToReview,
  reportReview,
  moderateReviewHandler,
  listFlaggedReviews,
  listPendingReviews,
  approveReviewHandler,
  rejectReviewHandler,
  getReviewResponseHistory,
  moderateHostResponseHandler,
} from '../controllers/review.controller.js';
import { validateBody } from '../validators/booking.validator.js';
import { createReviewSchema, flagReviewSchema } from '../validators/review.validator.js';
import { validatePagination } from '../validators/pagination.validator.js';

const router = Router();

// POST /api/reviews
router.post('/', authenticate, validateBody(createReviewSchema), createReview);

// GET /api/reviews/property/:id
router.get('/property/:id', validatePagination, getPropertyReviews);

// GET /api/reviews/user/:id
router.get('/user/:id', validatePagination, getUserReviews);

// GET /api/reviews/user/:id/average
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

// GET /api/reviews/moderation/pending — list pending reviews for moderation (admin)
router.get('/moderation/pending', authenticate, requireRole('admin'), listPendingReviews);

// PATCH /api/reviews/:id/moderate — approve or reject a flagged review (admin)
router.patch('/:id/moderate', authenticate, requireRole('admin'), moderateReviewHandler);

// POST /api/reviews/:id/approve — approve a review (admin)
router.post('/:id/approve', authenticate, requireRole('admin'), approveReviewHandler);

// POST /api/reviews/:id/reject — reject a review with reason (admin)
router.post('/:id/reject', authenticate, requireRole('admin'), rejectReviewHandler);

export default router;
