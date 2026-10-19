/**
 * Support Case Routes — Issue #847
 *
 * Customer-facing routes (authenticated, own-case access only):
 *   POST   /api/v1/support/cases
 *   GET    /api/v1/support/cases
 *   GET    /api/v1/support/cases/:id
 *   PATCH  /api/v1/support/cases/:id/customer-status
 *   GET    /api/v1/support/cases/:id/notes   ← non-internal only
 *
 * Staff routes live in admin.routes.ts under /api/v1/admin/support/cases
 */

import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import {
  createCaseHandler,
  listCustomerCasesHandler,
  getCustomerCaseHandler,
  updateCustomerStatusHandler,
  getCustomerCaseNotesHandler,
} from '@/controllers/supportCase.controller.js';

const router = Router();

// All support routes require a valid user session
router.use(authenticate);

router.post('/',                       createCaseHandler);
router.get('/',                        listCustomerCasesHandler);
router.get('/:id',                     getCustomerCaseHandler);
router.patch('/:id/customer-status',   updateCustomerStatusHandler);
router.get('/:id/notes',               getCustomerCaseNotesHandler);

export default router;
