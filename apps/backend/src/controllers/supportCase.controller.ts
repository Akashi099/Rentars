/**
 * Support Case Controller — Issue #847
 *
 * HTTP handlers for the support case API.
 * Customer routes: authenticate → own-case access only.
 * Staff routes:    requireAdminRole + requireScope → full access + audit trail.
 *
 * Internal notes are stripped from every customer-facing response.
 */

import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import type { AdminRequest } from '../middleware/adminScope.middleware.js';
import {
  createCase,
  getCaseById,
  listCases,
  updateCustomerStatus,
  updateCaseStatus,
  assignCase,
  addNote,
  getCaseNotes,
  getCaseAudit,
  CASE_STATUSES,
  CASE_PRIORITIES,
  type CaseStatus,
  type CasePriority,
} from '../services/supportCase.service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function httpStatus(code?: number, defaultCode = 500): number {
  return code ?? defaultCode;
}

// ─── Customer routes ─────────────────────────────────────────────────────────

/** POST /api/v1/support/cases */
export async function createCaseHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { subject, booking_id, message_id, payment_ref, dispute_ref, priority } = req.body;

  if (priority && !CASE_PRIORITIES.includes(priority as CasePriority)) {
    res.status(400).json({ error: `Invalid priority. Must be one of: ${CASE_PRIORITIES.join(', ')}` });
    return;
  }

  const result = await createCase(userId, { subject, booking_id, message_id, payment_ref, dispute_ref, priority });

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

/** GET /api/v1/support/cases */
export async function listCustomerCasesHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const limit  = Number(req.query.limit)  || 20;
  const offset = Number(req.query.offset) || 0;

  const result = await listCases(userId, false, { limit, offset });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** GET /api/v1/support/cases/:id */
export async function getCustomerCaseHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await getCaseById(req.params.id, userId, false);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 404)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** PATCH /api/v1/support/cases/:id/customer-status */
export async function updateCustomerStatusHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { customer_status } = req.body;
  if (!customer_status?.trim()) {
    res.status(400).json({ error: 'customer_status is required' });
    return;
  }

  const result = await updateCustomerStatus(req.params.id, userId, customer_status);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** GET /api/v1/support/cases/:id/notes — customer receives non-internal notes only */
export async function getCustomerCaseNotesHandler(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await getCaseNotes(req.params.id, userId, false);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 500)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

// ─── Staff routes (admin-scoped) ─────────────────────────────────────────────

/** GET /api/v1/admin/support/cases */
export async function listStaffCasesHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const filters = {
    status:     req.query.status     as CaseStatus | undefined,
    priority:   req.query.priority   as CasePriority | undefined,
    assignedTo: req.query.assigned_to as string | undefined,
    limit:      Number(req.query.limit)  || 50,
    offset:     Number(req.query.offset) || 0,
  };

  if (filters.status && !CASE_STATUSES.includes(filters.status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${CASE_STATUSES.join(', ')}` });
    return;
  }

  const result = await listCases(staffId, true, filters);

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** GET /api/v1/admin/support/cases/:id */
export async function getStaffCaseHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const reason = req.headers['x-access-reason'] as string | undefined;
  if (!reason?.trim()) {
    res.status(400).json({ error: 'X-Access-Reason header is required for staff case lookup' });
    return;
  }

  const result = await getCaseById(req.params.id, staffId, true, reason);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 404)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** PATCH /api/v1/admin/support/cases/:id/status */
export async function updateCaseStatusHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { status, reason, customer_status } = req.body;

  if (!status || !CASE_STATUSES.includes(status as CaseStatus)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${CASE_STATUSES.join(', ')}` });
    return;
  }

  const result = await updateCaseStatus(req.params.id, staffId, { status, reason, customer_status });

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** POST /api/v1/admin/support/cases/:id/assign */
export async function assignCaseHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { assignee_id, reason } = req.body;
  if (!assignee_id) {
    res.status(400).json({ error: 'assignee_id is required' });
    return;
  }

  const result = await assignCase(req.params.id, staffId, assignee_id, reason);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** POST /api/v1/admin/support/cases/:id/notes */
export async function addStaffNoteHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { body, is_internal } = req.body;

  const result = await addNote(req.params.id, staffId, {
    body,
    is_internal: is_internal !== false, // default to internal for safety
  });

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

/** GET /api/v1/admin/support/cases/:id/notes */
export async function getStaffCaseNotesHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const reason = req.headers['x-access-reason'] as string | undefined;

  const result = await getCaseNotes(req.params.id, staffId, true, reason);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 500)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/** GET /api/v1/admin/support/cases/:id/audit */
export async function getCaseAuditHandler(req: AdminRequest, res: Response): Promise<void> {
  const staffId = req.adminId;
  if (!staffId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const reason = (req.headers['x-access-reason'] as string) ?? req.query.reason as string;

  const result = await getCaseAudit(req.params.id, staffId, reason);

  if (!result.success) {
    res.status(httpStatus(result.statusCode, 400)).json({ error: result.error });
    return;
  }

  res.json(result.data);
}
