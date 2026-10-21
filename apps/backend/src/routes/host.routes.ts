import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { requireAdmin } from '@/middleware/admin.middleware.js';
import { getHostEarnings, getLedgerEntries, getLedgerBalance, getReconciliationReport, postLedgerAdjustment } from '@/controllers/earnings.controller.js';
import {
  getHostDashboard,
  listHostProperties,
  patchPropertyStatus,
} from '@/controllers/hostDashboard.controller.js';

const router = Router();

// GET /api/v1/host/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/earnings', authenticate, getHostEarnings);

// ── Ledger endpoints (#770) ────────────────────────────────────────────────────
// All append-only ledger queries are scoped to the authenticated host.

// GET /api/v1/host/ledger?from=&to=&currency=USDC&page=1&limit=50
router.get('/ledger', authenticate, getLedgerEntries);

// GET /api/v1/host/ledger/balance?from=&to=&currency=USDC
router.get('/ledger/balance', authenticate, getLedgerBalance);

// GET /api/v1/host/ledger/reconcile?from=&to=&currency=USDC
router.get('/ledger/reconcile', authenticate, getReconciliationReport);

// ── Admin-only adjustment posting (#770) ─────────────────────────────────────
// POST /api/v1/admin/host/:hostId/ledger/adjustment — mounted on admin routes
// (see admin.routes.ts for the admin mount point)
// This handler is also exported for the admin router to use.

// GET /api/v1/host/dashboard — summary stats for the host dashboard
router.get('/dashboard', authenticate, getHostDashboard);

// GET /api/v1/host/properties — host-scoped property listing with booking counts
router.get('/properties', authenticate, listHostProperties);

// PATCH /api/v1/host/properties/:id/status — publish/unpublish/draft a property
router.patch('/properties/:id/status', authenticate, patchPropertyStatus);

export { postLedgerAdjustment };

export default router;
