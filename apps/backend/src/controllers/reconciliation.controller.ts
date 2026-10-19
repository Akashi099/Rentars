/**
 * Reconciliation Operations Controller (#772)
 *
 * Provides support staff and finance operators with a restricted, audited view
 * of payment/booking reconciliation mismatches.
 *
 * Design principles:
 *  - No raw PII beyond what is strictly needed (no email, no full wallet key).
 *  - No secret payloads (provider API keys, XDR blobs) in responses.
 *  - Every manual action (retry, escalate) requires a reason and is audited.
 *  - All mutating operations are idempotent.
 *  - Pagination prevents unbounded result sets.
 *
 * Role access (enforced by adminScope.middleware):
 *  - Read:  admin, finance, support    (admin:reconciliation:read)
 *  - Write: admin, finance only        (admin:reconciliation:write)
 */

import type { Response } from 'express';
import { z } from 'zod';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import type { AdminRequest } from '@/middleware/admin.middleware.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

// ─── Validators ───────────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  status: z.enum(['pending', 'mismatch', 'failed', 'escalated', 'resolved']).optional(),
  /** Only return cases older than this many minutes (default: 0 = all). */
  olderThanMinutes: z.coerce.number().int().min(0).default(0),
});

const retrySchema = z.object({
  reason: z.string().min(5, 'reason must be at least 5 characters').max(500),
});

const escalateSchema = z.object({
  reason:      z.string().min(5, 'reason must be at least 5 characters').max(500),
  escalateTo:  z.string().min(1, 'escalateTo must specify a team or person').max(200),
});

// ─── Row → safe DTO ───────────────────────────────────────────────────────────

/**
 * Strip any field that must never reach an operator console:
 *  - tenant's personal data beyond their ID
 *  - raw provider API payloads
 *  - internal secrets or XDR blobs
 */
// biome-ignore lint/suspicious/noExplicitAny: raw DB row
function toReconciliationDTO(row: any) {
  return {
    id:                   row.id,
    bookingId:            row.booking_id,
    paymentId:            row.payment_id ?? null,
    tenantId:             row.tenant_id,          // pseudonymised; no email/name
    propertyId:           row.property_id,
    status:               row.status,
    reconcileAttempts:    row.reconcile_attempts ?? 0,
    escrowHash:           row.escrow_hash ?? null, // on-chain TX reference
    onChainId:            row.on_chain_id ?? null,
    lastReconcileAt:      row.last_reconcile_at ?? null,
    lastReconcileError:   row.last_reconcile_error ?? null,
    escalatedReason:      row.escalated_reason ?? null,
    escalatedTo:          row.escalated_to ?? null,
    escalatedAt:          row.escalated_at ?? null,
    createdAt:            row.created_at,
    updatedAt:            row.updated_at,
    // Audit trail link (read-only; full records available via /admin/audit-logs)
    auditTrailRef:        `/api/v1/admin/audit-logs?resource_id=${row.booking_id}&resource_type=booking`,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/reconciliation
 *
 * List reconciliation cases with optional status/age filters and pagination.
 *
 * Scopes required: admin:reconciliation:read
 */
export async function listReconciliationCases(req: AdminRequest, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { page, limit, status, olderThanMinutes } = parsed.data;
  const offset = (page - 1) * limit;

  let query = supabase
    .from('reconciliation_cases')
    .select(
      'id, booking_id, payment_id, tenant_id, property_id, status, ' +
      'reconcile_attempts, escrow_hash, on_chain_id, last_reconcile_at, ' +
      'last_reconcile_error, escalated_reason, escalated_to, escalated_at, ' +
      'created_at, updated_at',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  if (olderThanMinutes > 0) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    query = query.lt('created_at', cutoff);
  }

  const { data, error, count } = await query;

  if (error) {
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Unable to fetch reconciliation cases.' } });
    return;
  }

  res.json({
    data: (data ?? []).map(toReconciliationDTO),
    meta: {
      page,
      limit,
      total: count ?? 0,
      pages: Math.ceil((count ?? 0) / limit),
    },
  });
}

/**
 * GET /api/v1/admin/reconciliation/:id
 *
 * Retrieve a single reconciliation case with full audit trail reference.
 *
 * Scopes required: admin:reconciliation:read
 */
export async function getReconciliationCase(req: AdminRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('reconciliation_cases')
    .select(
      'id, booking_id, payment_id, tenant_id, property_id, status, ' +
      'reconcile_attempts, escrow_hash, on_chain_id, last_reconcile_at, ' +
      'last_reconcile_error, escalated_reason, escalated_to, escalated_at, ' +
      'created_at, updated_at',
    )
    .eq('id', id)
    .single();

  if (error || !data) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reconciliation case not found.' } });
    return;
  }

  res.json({ data: toReconciliationDTO(data) });
}

/**
 * POST /api/v1/admin/reconciliation/:id/retry
 *
 * Trigger a safe retry of the reconciliation job for this case.
 *
 * - Idempotent: if the case is already resolved, returns 409.
 * - Requires reason (audited).
 * - Increments reconcile_attempts; marks status back to 'pending'.
 *
 * Scopes required: admin:reconciliation:write
 */
export async function retryReconciliationCase(req: AdminRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = retrySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { reason } = parsed.data;

  // Fetch current state
  const { data: existing, error: fetchErr } = await supabase
    .from('reconciliation_cases')
    .select('id, status, reconcile_attempts, booking_id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reconciliation case not found.' } });
    return;
  }

  if (existing.status === 'resolved') {
    res.status(409).json({
      error: { code: 'ALREADY_RESOLVED', message: 'This case is already resolved. No retry needed.' },
    });
    return;
  }

  if (existing.status === 'escalated') {
    res.status(409).json({
      error: { code: 'CASE_ESCALATED', message: 'This case has been escalated. Retry is not allowed until de-escalated.' },
    });
    return;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('reconciliation_cases')
    .update({
      status: 'pending',
      reconcile_attempts: (existing.reconcile_attempts ?? 0) + 1,
      last_reconcile_at: new Date().toISOString(),
      last_reconcile_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr || !updated) {
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Failed to queue retry.' } });
    return;
  }

  await auditLogger.log({
    actorId: req.adminId,
    action: 'admin.settings_change',
    resourceType: 'booking',
    resourceId: existing.booking_id,
    success: true,
    meta: {
      operation: 'reconciliation_retry',
      caseId: id,
      reason,
      previousStatus: existing.status,
      reconcileAttempts: existing.reconcile_attempts,
    },
  });

  res.json({ data: toReconciliationDTO(updated), message: 'Reconciliation retry queued.' });
}

/**
 * POST /api/v1/admin/reconciliation/:id/escalate
 *
 * Escalate a stuck reconciliation case to a named team or person.
 *
 * - Idempotent: re-escalating updates the reason/target and audit log.
 * - Requires reason + escalateTo (both audited).
 *
 * Scopes required: admin:reconciliation:write
 */
export async function escalateReconciliationCase(req: AdminRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = escalateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { reason, escalateTo } = parsed.data;

  const { data: existing, error: fetchErr } = await supabase
    .from('reconciliation_cases')
    .select('id, status, booking_id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reconciliation case not found.' } });
    return;
  }

  if (existing.status === 'resolved') {
    res.status(409).json({
      error: { code: 'ALREADY_RESOLVED', message: 'Cannot escalate a resolved case.' },
    });
    return;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('reconciliation_cases')
    .update({
      status: 'escalated',
      escalated_reason: reason,
      escalated_to: escalateTo,
      escalated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr || !updated) {
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Failed to escalate case.' } });
    return;
  }

  await auditLogger.log({
    actorId: req.adminId,
    action: 'admin.settings_change',
    resourceType: 'booking',
    resourceId: existing.booking_id,
    success: true,
    meta: {
      operation: 'reconciliation_escalate',
      caseId: id,
      reason,
      escalateTo,
      previousStatus: existing.status,
    },
  });

  res.json({ data: toReconciliationDTO(updated), message: 'Case escalated.' });
}

/**
 * POST /api/v1/admin/reconciliation/:id/resolve
 *
 * Mark a reconciliation case as manually resolved.
 *
 * - Terminal: once resolved, retry and escalate are blocked.
 * - Requires reason (audited).
 *
 * Scopes required: admin:reconciliation:write
 */
export async function resolveReconciliationCase(req: AdminRequest, res: Response): Promise<void> {
  const { id } = req.params;

  const parsed = retrySchema.safeParse(req.body); // same shape: { reason }
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const { reason } = parsed.data;

  const { data: existing, error: fetchErr } = await supabase
    .from('reconciliation_cases')
    .select('id, status, booking_id')
    .eq('id', id)
    .single();

  if (fetchErr || !existing) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Reconciliation case not found.' } });
    return;
  }

  if (existing.status === 'resolved') {
    res.status(409).json({
      error: { code: 'ALREADY_RESOLVED', message: 'Case is already resolved.' },
    });
    return;
  }

  const { data: updated, error: updateErr } = await supabase
    .from('reconciliation_cases')
    .update({
      status: 'resolved',
      last_reconcile_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr || !updated) {
    res.status(500).json({ error: { code: 'DB_ERROR', message: 'Failed to resolve case.' } });
    return;
  }

  await auditLogger.log({
    actorId: req.adminId,
    action: 'admin.settings_change',
    resourceType: 'booking',
    resourceId: existing.booking_id,
    success: true,
    meta: {
      operation: 'reconciliation_resolve',
      caseId: id,
      reason,
      previousStatus: existing.status,
    },
  });

  res.json({ data: toReconciliationDTO(updated), message: 'Case resolved.' });
}
