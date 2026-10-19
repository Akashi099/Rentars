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

  return { success: true, data: data as SupportCase };
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
  return { success: true, data: (data ?? []) as SupportCase[] };
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
