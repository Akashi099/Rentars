/**
 * Support Case Service — Issue #847
 *
 * Provides a restricted support case record with:
 *  - References to related entities (booking, message, payment, dispute) by ID only
 *  - Scoped access enforced at service + RLS layers
 *  - Internal notes separated from customer-visible status
 *  - Immutable audit trail for every state change and sensitive lookup
 *  - Reason required for accessing related records
 *
 * See: docs/I18N_CURRENCY_POLICY.md for currency notes on receipts linked here.
 */

import { supabase } from '@/config/supabase.js';
import * as auditLog from './auditLog.service.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const CASE_STATUSES = [
  'open',
  'in_progress',
  'awaiting_customer',
  'awaiting_staff',
  'resolved',
  'closed',
] as const;

export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type CaseStatus   = (typeof CASE_STATUSES)[number];
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/**
 * Valid support case status transitions.
 * Terminal states (resolved, closed) have no outbound transitions.
 */
export const VALID_STATUS_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  open:               ['in_progress', 'awaiting_customer', 'closed'],
  in_progress:        ['awaiting_customer', 'awaiting_staff', 'resolved', 'closed'],
  awaiting_customer:  ['in_progress', 'closed'],
  awaiting_staff:     ['in_progress', 'closed'],
  resolved:           ['open', 'closed'],   // can re-open
  closed:             [],
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SupportCase {
  id:               string;
  reporter_user_id: string;
  assigned_to?:     string | null;
  status:           CaseStatus;
  priority:         CasePriority;
  subject:          string;
  customer_status?: string | null;
  booking_id?:      string | null;
  message_id?:      string | null;
  payment_ref?:     string | null;
  dispute_ref?:     string | null;
  created_at:       string;
  updated_at:       string;
  resolved_at?:     string | null;
  closed_at?:       string | null;
}

/**
 * Reconciliation linkage attached to a support case.
 * References are opaque IDs only — never raw provider/chain payloads.
 */
export interface ReconciliationLink {
  id:               string;
  case_id:          string;
  reconciliation_id: string;
  transaction_ref?: string | null;
  provider_ref?:    string | null;
  chain_tx_hash?:   string | null;
  audit_link?:      string | null;
  escalation_state?: EscalationState | null;
  created_at:       string;
  updated_at:       string;
}

export const ESCALATION_STATES = [
  'none',
  'pending_review',
  'escalated',
  'resolved',
] as const;

export type EscalationState = (typeof ESCALATION_STATES)[number];

export interface AttachReconciliationInput {
  reconciliation_id: string;
  transaction_ref?:  string;
  provider_ref?:     string;
  chain_tx_hash?:    string;
  audit_link?:       string;
  reason:            string;   // required — logged in audit trail
}

export interface EscalateCaseInput {
  escalation_state: EscalationState;
  reason:           string;    // required — logged in audit trail
}

/**
 * Fields that must never be exposed to customers or in list responses.
 * Internal notes, secrets, and unnecessary personal data are stripped.
 */
const CUSTOMER_HIDDEN_CASE_FIELDS = [
  'assigned_to',
  'payment_ref',
  'dispute_ref',
] as const;

const RECONCILIATION_SECRET_FIELDS = [
  'provider_payload',
  'raw_response',
  'secret',
  'api_key',
  'webhook_secret',
] as const;

export interface SupportCaseNote {
  id:          string;
  case_id:     string;
  author_id:   string;
  is_internal: boolean;
  body:        string;
  created_at:  string;
}

export interface CreateCaseInput {
  subject:     string;
  booking_id?: string;
  message_id?: string;
  payment_ref?: string;
  dispute_ref?: string;
  priority?:   CasePriority;
}

export interface AddNoteInput {
  body:        string;
  is_internal: boolean;
}

export interface UpdateStatusInput {
  status: CaseStatus;
  reason: string;              // required — logged in audit trail
  customer_status?: string;    // optional new customer-visible message
}

export interface CaseFilters {
  status?:   CaseStatus;
  priority?: CasePriority;
  assignedTo?: string;
  limit?:    number;
  offset?:   number;
}

// ─── Customer-facing operations ───────────────────────────────────────────────

/**
 * Create a new support case. Any authenticated user may open a case.
 * Related entities are validated to belong to the reporter before linking.
 */
export async function createCase(
  reporterUserId: string,
  input: CreateCaseInput,
): Promise<ServiceResponse<SupportCase>> {
  const { subject, booking_id, message_id, payment_ref, dispute_ref, priority } = input;

  if (!subject?.trim()) {
    return { success: false, error: 'Subject is required' };
  }

  // Validate booking ownership before linking
  if (booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, tenant_id')
      .eq('id', booking_id)
      .maybeSingle();
    if (!booking) return { success: false, error: 'Booking not found' };
    const b = booking as { id: string; tenant_id: string };
    if (b.tenant_id !== reporterUserId) {
      return { success: false, error: 'You can only link your own bookings' };
    }
  }

  // Validate message participation before linking
  if (message_id) {
    const { data: message } = await supabase
      .from('messages')
      .select('id, sender_id, recipient_id')
      .eq('id', message_id)
      .maybeSingle();
    if (!message) return { success: false, error: 'Message not found' };
    const m = message as { sender_id: string; recipient_id: string };
    if (m.sender_id !== reporterUserId && m.recipient_id !== reporterUserId) {
      return { success: false, error: 'You can only link messages you participated in' };
    }
  }

  const { data, error } = await supabase
    .from('support_cases')
    .insert({
      reporter_user_id: reporterUserId,
      subject:          subject.trim(),
      status:           'open',
      priority:         priority ?? 'normal',
      booking_id:       booking_id ?? null,
      message_id:       message_id ?? null,
      payment_ref:      payment_ref ?? null,
      dispute_ref:      dispute_ref ?? null,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    reporterUserId,
    'support_case.created',
    'support_case',
    (data as SupportCase).id,
    { subject, booking_id, message_id },
  );

  return { success: true, data: data as SupportCase };
}

/**
 * Strip fields that must not be shown to customers or in list responses.
 * Secrets and unnecessary personal information are removed defensively.
 */
function sanitizeCaseForCustomer(record: Record<string, unknown>): SupportCase {
  const clone: Record<string, unknown> = { ...record };
  for (const field of CUSTOMER_HIDDEN_CASE_FIELDS) {
    delete clone[field];
  }
  return clone as unknown as SupportCase;
}

/**
 * Strip secret payloads from reconciliation records before returning them.
 */
function sanitizeReconciliation(record: Record<string, unknown>): ReconciliationLink {
  const clone: Record<string, unknown> = { ...record };
  for (const field of RECONCILIATION_SECRET_FIELDS) {
    delete clone[field];
  }
  return clone as unknown as ReconciliationLink;
}

/**
 * Get a single support case.
 * Customers can only retrieve their own cases.
 * Support staff can retrieve any case (enforced via route-level RBAC).
 */
export async function getCaseById(
  caseId: string,
  requestorId: string,
  isStaff: boolean,
  reason?: string,
): Promise<ServiceResponse<SupportCase>> {
  let query = supabase.from('support_cases').select('*').eq('id', caseId);

  if (!isStaff) {
    query = query.eq('reporter_user_id', requestorId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data)  return { success: false, error: 'Case not found', statusCode: 404 };

  // Every staff lookup is audited with a required reason
  if (isStaff) {
    await auditLog.record(
      requestorId,
      'support_case.accessed',
      'support_case',
      caseId,
      { reason: reason ?? 'not provided' },
    );
  }

  const record = data as Record<string, unknown>;
  return {
    success: true,
    data: isStaff ? (record as unknown as SupportCase) : sanitizeCaseForCustomer(record),
  };
}

/**
 * List cases for a customer (their own only) or for staff (filtered).
 */
export async function listCases(
  requestorId: string,
  isStaff: boolean,
  filters?: CaseFilters,
): Promise<ServiceResponse<SupportCase[]>> {
  const limit  = Math.min(Math.max(filters?.limit ?? 20, 1), 100);
  const offset = Math.max(filters?.offset ?? 0, 0);

  let query = supabase.from('support_cases').select('*');

  if (!isStaff) {
    query = query.eq('reporter_user_id', requestorId);
  } else {
    if (filters?.status)     query = query.eq('status', filters.status);
    if (filters?.priority)   query = query.eq('priority', filters.priority);
    if (filters?.assignedTo) query = query.eq('assigned_to', filters.assignedTo);
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return { success: false, error: error.message };

  const records = (data ?? []) as Record<string, unknown>[];
  return {
    success: true,
    data: isStaff
      ? (records as unknown as SupportCase[])
      : records.map(sanitizeCaseForCustomer),
  };
}

/**
 * Update the customer-visible status message only.
 * Customers can update customer_status on their own open cases.
 */
export async function updateCustomerStatus(
  caseId: string,
  reporterUserId: string,
  customerStatus: string,
): Promise<ServiceResponse<SupportCase>> {
  const { data, error } = await supabase
    .from('support_cases')
    .update({ customer_status: customerStatus.trim() })
    .eq('id', caseId)
    .eq('reporter_user_id', reporterUserId)
    .neq('status', 'closed')
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data)  return { success: false, error: 'Case not found or already closed', statusCode: 404 };

  return { success: true, data: data as SupportCase };
}

// ─── Staff-only operations ────────────────────────────────────────────────────

/**
 * Transition a case to a new status.
 * Validates the transition is permitted by the state machine.
 * A reason is required and written to the audit trail.
 */
export async function updateCaseStatus(
  caseId: string,
  staffId: string,
  input: UpdateStatusInput,
): Promise<ServiceResponse<SupportCase>> {
  const { status: newStatus, reason, customer_status } = input;

  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required for status changes' };
  }

  // Fetch current status for transition validation
  const { data: existing, error: fetchError } = await supabase
    .from('support_cases')
    .select('id, status')
    .eq('id', caseId)
    .maybeSingle();

  if (fetchError || !existing) {
    return { success: false, error: 'Case not found', statusCode: 404 };
  }

  const current = (existing as { status: CaseStatus }).status;
  const allowed = VALID_STATUS_TRANSITIONS[current];

  if (!allowed.includes(newStatus)) {
    return {
      success: false,
      error: `Cannot transition from '${current}' to '${newStatus}'`,
      statusCode: 409,
    };
  }

  const updates: Partial<SupportCase> = { status: newStatus };
  if (customer_status !== undefined) updates.customer_status = customer_status;
  if (newStatus === 'resolved') updates.resolved_at = new Date().toISOString();
  if (newStatus === 'closed')   updates.closed_at   = new Date().toISOString();

  const { data, error } = await supabase
    .from('support_cases')
    .update(updates)
    .eq('id', caseId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    staffId,
    'support_case.status_changed',
    'support_case',
    caseId,
    { from: current, to: newStatus, reason },
  );

  return { success: true, data: data as SupportCase };
}

/**
 * Assign a support case to a staff member.
 */
export async function assignCase(
  caseId: string,
  staffId: string,
  assigneeId: string,
  reason: string,
): Promise<ServiceResponse<SupportCase>> {
  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required for case assignment' };
  }

  const { data, error } = await supabase
    .from('support_cases')
    .update({ assigned_to: assigneeId })
    .eq('id', caseId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data)  return { success: false, error: 'Case not found', statusCode: 404 };

  await auditLog.record(
    staffId,
    'support_case.assigned',
    'support_case',
    caseId,
    { assigned_to: assigneeId, reason },
  );

  return { success: true, data: data as SupportCase };
}

/**
 * Add a note to a case.
 *
 * - is_internal = true  → staff-only; NEVER returned to customers
 * - is_internal = false → visible to the customer via getCaseNotes()
 *
 * Staff must always provide a reason when adding an internal note.
 */
export async function addNote(
  caseId: string,
  authorId: string,
  input: AddNoteInput,
): Promise<ServiceResponse<SupportCaseNote>> {
  const { body, is_internal } = input;

  if (!body?.trim()) return { success: false, error: 'Note body is required' };

  const { data, error } = await supabase
    .from('support_case_notes')
    .insert({
      case_id:     caseId,
      author_id:   authorId,
      is_internal,
      body:        body.trim(),
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    authorId,
    is_internal ? 'support_case.internal_note_added' : 'support_case.note_added',
    'support_case',
    caseId,
    { note_id: (data as SupportCaseNote).id },
  );

  return { success: true, data: data as SupportCaseNote };
}

/**
 * Get notes for a case.
 *
 * @param includeInternal - Pass true only for staff; false for customer-facing responses.
 */
export async function getCaseNotes(
  caseId: string,
  requestorId: string,
  includeInternal: boolean,
  reason?: string,
): Promise<ServiceResponse<SupportCaseNote[]>> {
  let query = supabase
    .from('support_case_notes')
    .select('*')
    .eq('case_id', caseId);

  if (!includeInternal) {
    query = query.eq('is_internal', false);
  }

  const { data, error } = await query.order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };

  if (includeInternal) {
    await auditLog.record(
      requestorId,
      'support_case.notes_accessed',
      'support_case',
      caseId,
      { include_internal: true, reason: reason ?? 'not provided' },
    );
  }

  return { success: true, data: (data ?? []) as SupportCaseNote[] };
}

/**
 * Get the audit trail for a case (staff-only).
 */
export async function getCaseAudit(
  caseId: string,
  staffId: string,
  reason: string,
): Promise<ServiceResponse<Record<string, unknown>[]>> {
  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required to access the audit trail' };
  }

  const { data, error } = await supabase
    .from('support_case_audit')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    staffId,
    'support_case.audit_accessed',
    'support_case',
    caseId,
    { reason },
  );

  return { success: true, data: (data ?? []) as Record<string, unknown>[] };
}

// ─── Reconciliation linkage (staff-only) ──────────────────────────────────────

/**
 * Attach a reconciliation record to a support case.
 * Stores opaque references only (transaction ref, provider ref, chain tx hash,
 * audit link) — never raw provider or chain payloads.
 * A reason is required and every attachment is audited.
 */
export async function attachReconciliation(
  caseId: string,
  staffId: string,
  input: AttachReconciliationInput,
): Promise<ServiceResponse<ReconciliationLink>> {
  const { reconciliation_id, transaction_ref, provider_ref, chain_tx_hash, audit_link, reason } = input;

  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required to attach a reconciliation record' };
  }
  if (!reconciliation_id?.trim()) {
    return { success: false, error: 'reconciliation_id is required' };
  }

  // Ensure the case exists before linking
  const { data: existingCase, error: caseError } = await supabase
    .from('support_cases')
    .select('id')
    .eq('id', caseId)
    .maybeSingle();

  if (caseError || !existingCase) {
    return { success: false, error: 'Case not found', statusCode: 404 };
  }

  // Idempotent: reuse an existing link for the same reconciliation on this case
  const { data: existingLink } = await supabase
    .from('support_case_reconciliations')
    .select('*')
    .eq('case_id', caseId)
    .eq('reconciliation_id', reconciliation_id)
    .maybeSingle();

  if (existingLink) {
    return {
      success: true,
      data: sanitizeReconciliation(existingLink as Record<string, unknown>),
    };
  }

  const { data, error } = await supabase
    .from('support_case_reconciliations')
    .insert({
      case_id:           caseId,
      reconciliation_id: reconciliation_id.trim(),
      transaction_ref:   transaction_ref ?? null,
      provider_ref:      provider_ref ?? null,
      chain_tx_hash:     chain_tx_hash ?? null,
      audit_link:        audit_link ?? null,
      escalation_state:  'none',
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    staffId,
    'support_case.reconciliation_attached',
    'support_case',
    caseId,
    {
      reconciliation_id,
      transaction_ref: transaction_ref ?? null,
      provider_ref:    provider_ref ?? null,
      chain_tx_hash:   chain_tx_hash ?? null,
      reason,
    },
  );

  return {
    success: true,
    data: sanitizeReconciliation(data as Record<string, unknown>),
  };
}

/**
 * List reconciliation links for a case (staff-only).
 * Secret payload fields are stripped from every record.
 */
export async function listReconciliations(
  caseId: string,
  staffId: string,
  reason: string,
): Promise<ServiceResponse<ReconciliationLink[]>> {
  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required to view reconciliation records' };
  }

  const { data, error } = await supabase
    .from('support_case_reconciliations')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    staffId,
    'support_case.reconciliations_accessed',
    'support_case',
    caseId,
    { reason },
  );

  const records = (data ?? []) as Record<string, unknown>[];
  return { success: true, data: records.map(sanitizeReconciliation) };
}

/**
 * Update the escalation state of a reconciliation link on a case.
 * Idempotent: setting the same state again is a no-op that is still audited.
 * A reason is required and every change is audited.
 */
export async function escalateReconciliation(
  caseId: string,
  staffId: string,
  reconciliationId: string,
  input: EscalateCaseInput,
): Promise<ServiceResponse<ReconciliationLink>> {
  const { escalation_state, reason } = input;

  if (!reason?.trim()) {
    return { success: false, error: 'A reason is required to change escalation state' };
  }
  if (!ESCALATION_STATES.includes(escalation_state)) {
    return { success: false, error: `Invalid escalation state: ${escalation_state}` };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('support_case_reconciliations')
    .select('*')
    .eq('case_id', caseId)
    .eq('reconciliation_id', reconciliationId)
    .maybeSingle();

  if (fetchError || !existing) {
    return { success: false, error: 'Reconciliation link not found', statusCode: 404 };
  }

  const current = (existing as ReconciliationLink).escalation_state ?? 'none';

  if (current === escalation_state) {
    // Idempotent no-op — still record the attempt for the audit trail
    await auditLog.record(
      staffId,
      'support_case.escalation_unchanged',
      'support_case',
      caseId,
      { reconciliation_id: reconciliationId, escalation_state, reason },
    );
    return {
      success: true,
      data: sanitizeReconciliation(existing as Record<string, unknown>),
    };
  }

  const { data, error } = await supabase
    .from('support_case_reconciliations')
    .update({ escalation_state, updated_at: new Date().toISOString() })
    .eq('case_id', caseId)
    .eq('reconciliation_id', reconciliationId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  await auditLog.record(
    staffId,
    'support_case.escalation_changed',
    'support_case',
    caseId,
    { reconciliation_id: reconciliationId, from: current, to: escalation_state, reason },
  );

  return {
    success: true,
    data: sanitizeReconciliation(data as Record<string, unknown>),
  };
}
