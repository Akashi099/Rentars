/**
 * Privacy routes — data subject rights endpoints.
 *
 * POST   /api/v1/privacy/export                          — request an async export (202)
 * GET    /api/v1/privacy/export/:exportId                — poll status; payload when completed
 * POST   /api/v1/privacy/delete-account                  — request deletion (password + confirmation)
 * GET    /api/v1/privacy/delete-account/:deletionId      — deletion status
 * POST   /api/v1/privacy/delete-account/:deletionId/cancel — cancel within the 7-day window
 *
 * All endpoints are authenticated and rate-limited. Handlers live in
 * controllers/privacy.controller.ts.
 */

import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';
import {
  cancelDeletion,
  getDeletion,
  getExport,
  requestDeletion,
  startExport,
} from '@/controllers/privacy.controller.js';

const router = Router();

/** Max one export request per user per hour. */
const exportLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyPrefix: 'rl:privacy:export',
});

/** Max three deletion attempts per user per day (covers wrong-password retries). */
const deletionLimiter = createUserRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyPrefix: 'rl:privacy:delete',
});

router.post('/export', authenticate, exportLimiter, startExport);
router.get('/export/:exportId', authenticate, getExport);

router.post('/delete-account', authenticate, deletionLimiter, requestDeletion);
router.get('/delete-account/:deletionId', authenticate, getDeletion);
router.post('/delete-account/:deletionId/cancel', authenticate, cancelDeletion);

export default router;
