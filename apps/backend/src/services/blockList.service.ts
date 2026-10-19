/**
 * Block List Service
 *
 * User-to-user blocking and content abuse reporting.
 *
 * Block semantics:
 *  - blockUser()          — blocker can no longer receive messages from blocked user
 *  - unblockUser()        — removes the block
 *  - isBlocked()          — check whether A has blocked B (or B has blocked A)
 *  - getBlockedUserIds()  — list of IDs the caller has blocked
 *
 * Abuse reports (messages, reviews, notifications, users):
 *  - createAbuseReport()  — submit a report; deduplicates open reports per target
 *  - listAbuseReports()   — admin: list open/all reports with filters
 *  - resolveAbuseReport() — admin: mark resolved with a resolution note
 *  - dismissAbuseReport() — admin: dismiss without action
 */

import { supabase } from '../config/supabase.js';
import { sanitizeLongText } from '../utils/sanitize.js';
import type { ServiceResponse } from './index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AbuseTargetType = 'message' | 'review' | 'notification' | 'user';

export type AbuseReason =
  | 'spam'
  | 'harassment'
  | 'hate_speech'
  | 'phishing'
  | 'unsafe_link'
  | 'impersonation'
  | 'inappropriate_content'
  | 'other';

export type AbuseReportStatus = 'open' | 'under_review' | 'resolved' | 'dismissed';

export interface UserBlock {
  id: string;
  blocker_id: string;
  blocked_id: string;
  reason: string | null;
  created_at: string;
}

export interface AbuseReport {
  id: string;
  reporter_id: string;
  target_type: AbuseTargetType;
  target_id: string;
  reason: AbuseReason;
  detail: string | null;
  status: AbuseReportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Block operations ─────────────────────────────────────────────────────────

/**
 * Block a user. Idempotent — blocking an already-blocked user is a no-op.
 */
export async function blockUser(
  blockerId: string,
  blockedId: string,
  reason?: string,
): Promise<ServiceResponse<UserBlock>> {
  if (blockerId === blockedId) {
    return { success: false, error: 'You cannot block yourself' };
  }

  const { data, error } = await supabase
    .from('user_blocks')
    .upsert(
      {
        blocker_id: blockerId,
        blocked_id: blockedId,
        reason: reason ? sanitizeLongText(reason, 500) : null,
      },
      { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true },
    )
    .select()
    .single();

  // If ignoreDuplicates swallowed the row, do a follow-up select
  if (!data && !error) {
    const { data: existing, error: selectError } = await supabase
      .from('user_blocks')
      .select('*')
      .eq('blocker_id', blockerId)
      .eq('blocked_id', blockedId)
      .single();

    if (selectError || !existing) {
      return { success: false, error: selectError?.message ?? 'Block not found' };
    }
    return { success: true, data: existing as UserBlock };
  }

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as UserBlock };
}

/**
 * Remove a block. Silently succeeds if no block exists.
 */
export async function unblockUser(
  blockerId: string,
  blockedId: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('user_blocks')
    .delete()
    .eq('blocker_id', blockerId)
    .eq('blocked_id', blockedId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Check whether there is a block in either direction between userA and userB.
 * Used by the messaging service before allowing a message to be sent.
 *
 * @returns true if either party has blocked the other.
 */
export async function isBlocked(userA: string, userB: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_blocks')
    .select('id')
    .or(
      `and(blocker_id.eq.${userA},blocked_id.eq.${userB}),` +
      `and(blocker_id.eq.${userB},blocked_id.eq.${userA})`,
    )
    .limit(1);

  if (error || !data || data.length === 0) return false;
  return true;
}

/**
 * Return the list of user IDs that `userId` has blocked.
 */
export async function getBlockedUserIds(userId: string): Promise<ServiceResponse<string[]>> {
  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocked_id')
    .eq('blocker_id', userId);

  if (error) return { success: false, error: error.message };
  return {
    success: true,
    data: (data ?? []).map((r: { blocked_id: string }) => r.blocked_id),
  };
}

/**
 * Return the list of user IDs that have blocked `userId`.
 * Used to prevent blocked users from initiating contact.
 */
export async function getUsersWhoBlocked(userId: string): Promise<ServiceResponse<string[]>> {
  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocker_id')
    .eq('blocked_id', userId);

  if (error) return { success: false, error: error.message };
  return {
    success: true,
    data: (data ?? []).map((r: { blocker_id: string }) => r.blocker_id),
  };
}

// ─── Abuse reports ────────────────────────────────────────────────────────────

const VALID_TARGET_TYPES: AbuseTargetType[] = ['message', 'review', 'notification', 'user'];
const VALID_REASONS: AbuseReason[] = [
  'spam', 'harassment', 'hate_speech', 'phishing',
  'unsafe_link', 'impersonation', 'inappropriate_content', 'other',
];

/**
 * Submit an abuse report. One open report per (reporter, target) is enforced
 * so a user cannot flood the moderation queue with duplicate reports.
 */
export async function createAbuseReport(
  reporterId: string,
  targetType: AbuseTargetType,
  targetId: string,
  reason: AbuseReason,
  detail?: string,
): Promise<ServiceResponse<AbuseReport>> {
  if (!VALID_TARGET_TYPES.includes(targetType)) {
    return { success: false, error: `Invalid target type: ${targetType}` };
  }
  if (!VALID_REASONS.includes(reason)) {
    return { success: false, error: `Invalid reason: ${reason}` };
  }

  const cleanDetail = detail ? sanitizeLongText(detail, 1_000) : null;

  // Check for an existing open report from this reporter for the same target
  const { data: existing } = await supabase
    .from('abuse_reports')
    .select('id')
    .eq('reporter_id', reporterId)
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .in('status', ['open', 'under_review'])
    .maybeSingle();

  if (existing) {
    return {
      success: false,
      error: 'You already have an open report for this item. Our team is reviewing it.',
    };
  }

  const { data, error } = await supabase
    .from('abuse_reports')
    .insert({
      reporter_id: reporterId,
      target_type: targetType,
      target_id: targetId,
      reason,
      detail: cleanDetail,
      status: 'open',
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AbuseReport };
}

export interface ListAbuseReportsFilter {
  status?: AbuseReportStatus;
  targetType?: AbuseTargetType;
  page?: number;
  limit?: number;
}

/**
 * List abuse reports for admin review.
 */
export async function listAbuseReports(
  filter: ListAbuseReportsFilter = {},
): Promise<ServiceResponse<{ data: AbuseReport[]; total: number }>> {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const offset = (page - 1) * limit;

  let query = supabase
    .from('abuse_reports')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filter.status) query = query.eq('status', filter.status);
  if (filter.targetType) query = query.eq('target_type', filter.targetType);

  const { data, error, count } = await query;

  if (error) return { success: false, error: error.message };
  return { success: true, data: { data: (data ?? []) as AbuseReport[], total: count ?? 0 } };
}

/**
 * Mark a report as resolved with an optional resolution note.
 */
export async function resolveAbuseReport(
  reportId: string,
  resolvedBy: string,
  resolutionNote?: string,
): Promise<ServiceResponse<AbuseReport>> {
  const { data, error } = await supabase
    .from('abuse_reports')
    .update({
      status: 'resolved',
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
      resolution_note: resolutionNote
        ? sanitizeLongText(resolutionNote, 2_000)
        : null,
    })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AbuseReport };
}

/**
 * Dismiss a report without taking action.
 */
export async function dismissAbuseReport(
  reportId: string,
  resolvedBy: string,
  note?: string,
): Promise<ServiceResponse<AbuseReport>> {
  const { data, error } = await supabase
    .from('abuse_reports')
    .update({
      status: 'dismissed',
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
      resolution_note: note ? sanitizeLongText(note, 2_000) : null,
    })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as AbuseReport };
}
