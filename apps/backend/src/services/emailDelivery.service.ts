/**
 * Email Delivery Tracking Service
 *
 * Provides:
 *  - createDeliveryRecord()   — log a queued send attempt before handoff to SMTP
 *  - markSent()               — update record when nodemailer accepts the message
 *  - markDelivered()          — called from webhook on successful delivery event
 *  - markBounced()            — hard/soft bounce handling + auto-suppression
 *  - markComplaint()          — spam-complaint handling + auto-suppression
 *  - markFailed()             — transient failure with optional retry scheduling
 *  - isEmailSuppressed()      — fast lookup before every send (hot path)
 *  - suppressEmail()          — manual / programmatic suppression
 *  - liftSuppression()        — admin unsuppression
 *  - getRecentFailures()      — admin dashboard: last N failed records
 *
 * Email content is NEVER stored here. Only metadata (recipient hash, template
 * key, provider message ID, status, error codes) is persisted.
 *
 * Suppression logic:
 *  - Hard bounce  → permanent suppress_all entry
 *  - Spam complaint → permanent suppress_all entry
 *  - Manual entry → caller decides suppress_all vs template-scoped
 *  - Security emails (is_security_email=true) bypass suppression checks so
 *    password-reset and verification mails always go through.
 */

import { createHash } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complaint'
  | 'failed'
  | 'suppressed';

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual' | 'unsubscribe';

export interface EmailDeliveryRecord {
  id: string;
  recipient_hash: string;
  recipient_domain: string;
  template_key: string;
  template_version: number;
  notification_id: string | null;
  is_security_email: boolean;
  is_essential: boolean;
  provider_message_id: string | null;
  provider_name: string;
  status: DeliveryStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  complaint_at: string | null;
  next_retry_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SuppressedEmail {
  id: string;
  email_hash: string;
  email_address: string;
  reason: SuppressionReason;
  source_log_id: string | null;
  suppress_all: boolean;
  suppressed_templates: string[] | null;
  notes: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface CreateDeliveryRecordInput {
  recipientEmail: string;
  templateKey: string;
  templateVersion?: number;
  notificationId?: string;
  isSecurityEmail?: boolean;
  isEssential?: boolean;
  providerName?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Hash an email address for storage. We use SHA-256 of the lowercased address
 * so we can look up suppressions without storing a plaintext index on PII.
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function extractDomain(email: string): string {
  const parts = email.toLowerCase().trim().split('@');
  return parts.length === 2 ? (parts[1] ?? 'unknown') : 'unknown';
}

// ─── Core CRUD ────────────────────────────────────────────────────────────────

/**
 * Insert a delivery log record in the 'queued' state.
 * Call this right before handing off to nodemailer.
 */
export async function createDeliveryRecord(
  input: CreateDeliveryRecordInput,
): Promise<ServiceResponse<EmailDeliveryRecord>> {
  const {
    recipientEmail,
    templateKey,
    templateVersion = 1,
    notificationId,
    isSecurityEmail = false,
    isEssential = false,
    providerName = 'smtp',
  } = input;

  const { data, error } = await supabase
    .from('email_delivery_log')
    .insert({
      recipient_hash: hashEmail(recipientEmail),
      recipient_domain: extractDomain(recipientEmail),
      template_key: templateKey,
      template_version: templateVersion,
      notification_id: notificationId ?? null,
      is_security_email: isSecurityEmail,
      is_essential: isEssential,
      provider_name: providerName,
      status: 'queued',
      attempt_count: 1,
      last_attempt_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as EmailDeliveryRecord };
}

/**
 * Mark a delivery record as 'sent' once the SMTP server accepted the message.
 * Stores the provider-assigned message ID for later webhook correlation.
 */
export async function markSent(
  recordId: string,
  providerMessageId: string | null,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('email_delivery_log')
    .update({
      status: 'sent',
      provider_message_id: providerMessageId,
    })
    .eq('id', recordId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Mark delivered — called when the provider webhook reports a successful delivery.
 */
export async function markDelivered(
  recordId: string,
  deliveredAt?: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('email_delivery_log')
    .update({
      status: 'delivered',
      delivered_at: deliveredAt ?? new Date().toISOString(),
    })
    .eq('id', recordId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Mark bounced and, for hard bounces, automatically suppress the address.
 *
 * @param isSoft  - If true (soft bounce / temporary failure) do NOT suppress.
 *                  If false (hard bounce / invalid address) suppress permanently.
 */
export async function markBounced(
  recordId: string,
  recipientEmail: string,
  isSoft: boolean,
  errorCode?: string,
  errorMessage?: string,
): Promise<ServiceResponse<void>> {
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('email_delivery_log')
    .update({
      status: 'bounced',
      bounced_at: now,
      error_code: errorCode ?? null,
      error_message: errorMessage ?? null,
    })
    .eq('id', recordId);

  if (error) return { success: false, error: error.message };

  // Hard bounce → permanent suppression (no future sends to this address)
  if (!isSoft) {
    await suppressEmail(recipientEmail, 'hard_bounce', recordId, null);
  }

  return { success: true };
}

/**
 * Mark a complaint (spam report) and permanently suppress the address.
 */
export async function markComplaint(
  recordId: string,
  recipientEmail: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('email_delivery_log')
    .update({
      status: 'complaint',
      complaint_at: new Date().toISOString(),
    })
    .eq('id', recordId);

  if (error) return { success: false, error: error.message };

  await suppressEmail(recipientEmail, 'complaint', recordId, null);

  return { success: true };
}

/**
 * Mark a transient failure and optionally schedule a retry.
 *
 * @param nextRetryAt - ISO timestamp for the next retry. Null = no retry.
 */
export async function markFailed(
  recordId: string,
  errorCode?: string,
  errorMessage?: string,
  nextRetryAt?: string | null,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('email_delivery_log')
    .update({
      status: 'failed',
      error_code: errorCode ?? null,
      error_message: errorMessage ?? null,
      next_retry_at: nextRetryAt ?? null,
    })
    .eq('id', recordId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Increment attempt_count and reset status to 'queued' when a retry fires.
 */
export async function incrementAttempt(recordId: string): Promise<ServiceResponse<void>> {
  const { error } = await supabase.rpc('increment_email_attempt', { record_id: recordId });
  if (error) {
    // Fallback if RPC not available — read-modify-write (not atomic but acceptable for retry)
    const { data: current } = await supabase
      .from('email_delivery_log')
      .select('attempt_count')
      .eq('id', recordId)
      .single();

    const count = (current as { attempt_count: number } | null)?.attempt_count ?? 0;

    const { error: updateError } = await supabase
      .from('email_delivery_log')
      .update({
        attempt_count: count + 1,
        last_attempt_at: new Date().toISOString(),
        status: 'queued',
        next_retry_at: null,
      })
      .eq('id', recordId);

    if (updateError) return { success: false, error: updateError.message };
  }

  return { success: true };
}

// ─── Suppression ──────────────────────────────────────────────────────────────

/**
 * Check whether an email address is currently suppressed.
 *
 * Security emails (password reset, verification) bypass suppression — they are
 * always delivered regardless of bounce/complaint history.
 *
 * @param email            - Raw recipient email address.
 * @param templateKey      - Template being sent; checked against per-template suppression.
 * @param isSecurityEmail  - If true, bypass suppression entirely.
 */
export async function isEmailSuppressed(
  email: string,
  templateKey: string,
  isSecurityEmail = false,
): Promise<boolean> {
  if (isSecurityEmail) return false;

  const hash = hashEmail(email);
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('suppressed_emails')
    .select('id, suppress_all, suppressed_templates, expires_at')
    .eq('email_hash', hash)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .maybeSingle();

  if (error || !data) return false;

  const row = data as SuppressedEmail;

  // suppress_all = TRUE → suppress every non-security mail
  if (row.suppress_all) return true;

  // Template-scoped suppression
  if (row.suppressed_templates && row.suppressed_templates.includes(templateKey)) return true;

  return false;
}

/**
 * Add an email address to the suppression list.
 *
 * @param email          - Raw address to suppress.
 * @param reason         - Why it's being suppressed.
 * @param sourceLogId    - Delivery log record that triggered this (nullable).
 * @param templates      - Null = suppress all; array = suppress only these templates.
 * @param notes          - Optional operator notes.
 * @param expiresAt      - ISO timestamp for temporary suppression. Null = permanent.
 */
export async function suppressEmail(
  email: string,
  reason: SuppressionReason,
  sourceLogId: string | null,
  templates: string[] | null,
  notes?: string,
  expiresAt?: string | null,
): Promise<ServiceResponse<void>> {
  const hash = hashEmail(email);
  const address = email.toLowerCase().trim();

  const { error } = await supabase
    .from('suppressed_emails')
    .upsert(
      {
        email_hash: hash,
        email_address: address,
        reason,
        source_log_id: sourceLogId,
        suppress_all: templates === null,
        suppressed_templates: templates,
        notes: notes ?? null,
        expires_at: expiresAt ?? null,
      },
      { onConflict: 'email_hash', ignoreDuplicates: false },
    );

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Remove a suppression entry (admin action — used after a user confirms their
 * address is valid again or explicitly requests re-enrollment).
 */
export async function liftSuppression(email: string): Promise<ServiceResponse<void>> {
  const hash = hashEmail(email);

  const { error } = await supabase
    .from('suppressed_emails')
    .delete()
    .eq('email_hash', hash);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Admin / dashboard queries ────────────────────────────────────────────────

export interface RecentFailure {
  id: string;
  recipient_domain: string;
  template_key: string;
  status: DeliveryStatus;
  error_code: string | null;
  error_message: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  created_at: string;
}

/**
 * Return the N most recent non-successful delivery records.
 * Deliberately omits recipient_hash to avoid surfacing hashed PII in bulk
 * admin responses — join on notification_id to get context when needed.
 */
export async function getRecentFailures(limit = 50): Promise<ServiceResponse<RecentFailure[]>> {
  const { data, error } = await supabase
    .from('email_delivery_log')
    .select(
      'id, recipient_domain, template_key, status, error_code, error_message, attempt_count, last_attempt_at, created_at',
    )
    .in('status', ['bounced', 'complaint', 'failed', 'suppressed'])
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, 200));

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as RecentFailure[] };
}

/**
 * Delivery stats for the admin dashboard:
 * counts by status over the last N hours (default 24).
 */
export async function getDeliveryStats(
  windowHours = 24,
): Promise<ServiceResponse<Record<DeliveryStatus, number>>> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from('email_delivery_log')
    .select('status')
    .gte('created_at', since);

  if (error) return { success: false, error: error.message };

  const counts: Record<DeliveryStatus, number> = {
    queued: 0,
    sent: 0,
    delivered: 0,
    bounced: 0,
    complaint: 0,
    failed: 0,
    suppressed: 0,
  };

  for (const row of data as { status: DeliveryStatus }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }

  return { success: true, data: counts };
}

/**
 * Return suppressed address count and the 20 most recent entries (admin view).
 * Email addresses are returned as-is for operator review; access is gated at
 * the route level by admin:email:read scope.
 */
export async function getSuppressionList(
  limit = 20,
): Promise<ServiceResponse<{ total: number; entries: SuppressedEmail[] }>> {
  const [countResult, rowsResult] = await Promise.all([
    supabase.from('suppressed_emails').select('id', { count: 'exact', head: true }),
    supabase
      .from('suppressed_emails')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, 200)),
  ]);

  if (countResult.error) return { success: false, error: countResult.error.message };
  if (rowsResult.error) return { success: false, error: rowsResult.error.message };

  return {
    success: true,
    data: {
      total: countResult.count ?? 0,
      entries: (rowsResult.data ?? []) as SuppressedEmail[],
    },
  };
}

/**
 * Look up a delivery record by provider message ID.
 * Used by the webhook handler to correlate incoming events.
 */
export async function findByProviderMessageId(
  providerMessageId: string,
): Promise<ServiceResponse<EmailDeliveryRecord | null>> {
  const { data, error } = await supabase
    .from('email_delivery_log')
    .select('*')
    .eq('provider_message_id', providerMessageId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data as EmailDeliveryRecord | null) ?? null };
}
