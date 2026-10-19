/**
 * Reconciliation Operations Routes (#772)
 *
 * All routes are mounted under /api/v1/admin/reconciliation and are
 * protected by two layers:
 *   1. requireAdminRole   — caller must have an admin-family JWT role
 *   2. requireScope(...)  — specific capability per endpoint
 *
 * Scope mapping:
 *   GET    /                  admin:reconciliation:read   (admin, finance, support)
 *   GET    /:id               admin:reconciliation:read
 *   POST   /:id/retry         admin:reconciliation:write  (admin, finance)
 *   POST   /:id/escalate      admin:reconciliation:write
 *   POST   /:id/resolve       admin:reconciliation:write
 */

import { Router } from 'express';
import { requireScope } from '@/middleware/adminScope.middleware.js';
import {
  listReconciliationCases,
  getReconciliationCase,
  retryReconciliationCase,
  escalateReconciliationCase,
  resolveReconciliationCase,
} from '@/controllers/reconciliation.controller.js';

const router = Router();

// ── Read routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/reconciliation
 * Paginated list with optional status + age filters.
 * Roles: admin, finance, support
 */
router.get('/', requireScope('admin:reconciliation:read'), listReconciliationCases);

/**
 * GET /api/v1/admin/reconciliation/:id
 * Single case detail with audit trail reference.
 * Roles: admin, finance, support
 */
router.get('/:id', requireScope('admin:reconciliation:read'), getReconciliationCase);

// ── Write routes ──────────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/reconciliation/:id/retry
 * Queue a safe reconciliation retry.
 * Roles: admin, finance
 * Body: { reason: string }
 */
router.post('/:id/retry', requireScope('admin:reconciliation:write'), retryReconciliationCase);

/**
 * POST /api/v1/admin/reconciliation/:id/escalate
 * Escalate to a named team/person.
 * Roles: admin, finance
 * Body: { reason: string; escalateTo: string }
 */
router.post('/:id/escalate', requireScope('admin:reconciliation:write'), escalateReconciliationCase);

/**
 * POST /api/v1/admin/reconciliation/:id/resolve
 * Manually mark a case as resolved (terminal).
 * Roles: admin, finance
 * Body: { reason: string }
 */
router.post('/:id/resolve', requireScope('admin:reconciliation:write'), resolveReconciliationCase);

export default router;
