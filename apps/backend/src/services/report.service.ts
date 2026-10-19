/**
 * Report service — abuse reports against listings (properties) and reviews.
 */

import { supabase } from '../config/supabase.js';
import { createNotification, shouldSendInApp } from './notification.service.js';
import type { ServiceResponse } from './index.js';

export type ReportTargetType = 'property' | 'review';
export type ReportStatus = 'pending' | 'resolved' | 'dismissed' | 'escalated';
export type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AppealStatus = 'none' | 'pending' | 'approved' | 'denied';
export const REPORT_REASONS = [
  'spam',
  'fraud',
  'inappropriate',
  'misleading',
  'harassment',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface Report {
  id: string;
  target_type: ReportTargetType;
  target_id: string;
  reporter_id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  assigned_to: string | null;
  evidence?: unknown[];
  appeal_status?: AppealStatus;
  appeal_reason?: string | null;
  severity?: ReportSeverity;
  hide_property?: boolean;
  host_notified?: boolean;
  notify_host?: boolean;
  created_at: string;
  updated_at: string;
}

const UNIQUE_VIOLATION = '23505';

/** Maximum length of an appeal reason, in characters. */
const MAX_APPEAL_REASON_LENGTH = 2_000;

/**
 * Confirm a report target exists and is still live. For listings, also return the
 * owner so callers can enforce self-report rules and route host notices.
 */
async function loadReportTarget(
  targetType: ReportTargetType,
  targetId: string,
): Promise<ServiceResponse<{ ownerId: string | null }>> {
  if (targetType === 'property') {
    const { data, error } = await supabase
      .from('properties')
      .select('owner_id, deleted_at')
      .eq('id', targetId)
      .maybeSingle();

    if (error || !data || (data as { deleted_at: string | null }).deleted_at) {
      return { success: false, error: 'Reported listing not found', statusCode: 404 };
    }
    return { success: true, data: { ownerId: (data as { owner_id: string }).owner_id } };
  }

  const { data, error } = await supabase
    .from('reviews')
    .select('id')
    .eq('id', targetId)
    .maybeSingle();

  if (error || !data) {
    return { success: false, error: 'Reported review not found', statusCode: 404 };
  }
  return { success: true, data: { ownerId: null } };
}

/**
 * Set a listing's moderation visibility. This never touches `deleted_at`, so a
 * host's own removal is not reversed by a moderation decision.
 */
async function setListingModerationState(
  propertyId: string,
  state: 'visible' | 'hidden',
): Promise<ServiceResponse<null>> {
  const { error } = await supabase
    .from('properties')
    .update({ moderation_state: state, moderation_updated_at: new Date().toISOString() })
    .eq('id', propertyId);

  if (error) return { success: false, error: error.message };
  return { success: true, data: null };
}

/**
 * True when another report still has an active hide on this listing. A listing
 * stays hidden until every hide decision has been lifted.
 */
async function hasOtherActiveHide(propertyId: string, exceptReportId: string): Promise<boolean> {
  const { data } = await supabase
    .from('reports')
    .select('id')
    .eq('target_type', 'property')
    .eq('target_id', propertyId)
    .eq('hide_property', true)
    .neq('id', exceptReportId)
    .limit(1);

  return Array.isArray(data) && data.length > 0;
}

/**
 * Submit an abuse report for a property listing or review.
 * Duplicate reports (same reporter + target) are rejected as a conflict.
 */
export async function submitReport(
  reporterId: string,
  targetType: ReportTargetType,
  targetId: string,
  reason: ReportReason,
  details?: string,
): Promise<ServiceResponse<Report>> {
  if (!['property', 'review'].includes(targetType)) {
    return { success: false, error: 'target_type must be "property" or "review"' };
  }
  if (!REPORT_REASONS.includes(reason)) {
    return { success: false, error: `reason must be one of: ${REPORT_REASONS.join(', ')}` };
  }

  // Validate the target exists and that the reporter is not reporting their own listing.
  const target = await loadReportTarget(targetType, targetId);
  if (!target.success) {
    return { success: false, error: target.error, statusCode: target.statusCode };
  }
  if (targetType === 'property' && target.data?.ownerId === reporterId) {
    return { success: false, error: 'You cannot report your own listing', statusCode: 422 };
  }

  const { data, error } = await supabase
    .from('reports')
    .insert({
      target_type: targetType,
      target_id: targetId,
      reporter_id: reporterId,
      reason,
      details: details || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return {
        success: false,
        error: 'You have already reported this item',
        conflict: true,
        statusCode: 409,
      };
    }
    return { success: false, error: error.message };
  }

  await notifyModerators(data as Report);

  return { success: true, data: data as Report };
}

/**
 * List reports, optionally filtered by status and/or target type.
 * Moderator-only.
 */
export async function listReports(filters?: {
  status?: ReportStatus;
  targetType?: ReportTargetType;
}): Promise<ServiceResponse<Report[]>> {
  let query = supabase.from('reports').select('*');

  if (filters?.status) {
    query = query.eq('status', filters.status);
  }
  if (filters?.targetType) {
    query = query.eq('target_type', filters.targetType);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Report[] };
}

/**
 * Resolve or dismiss a report. Moderator-only.
 */
export async function resolveReport(
  reportId: string,
  resolverId: string,
  status: Extract<ReportStatus, 'resolved' | 'dismissed'>,
  resolutionNote?: string,
): Promise<ServiceResponse<Report>> {
  if (status !== 'resolved' && status !== 'dismissed') {
    return { success: false, error: 'status must be "resolved" or "dismissed"' };
  }

  const { data, error } = await supabase
    .from('reports')
    .update({
      status,
      resolved_by: resolverId,
      resolution_note: resolutionNote || null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Report not found' };

  const { record } = await import('./auditLog.service.js');
  await record(resolverId, `report.${status}`, 'report', reportId, { resolutionNote });

  return { success: true, data: data as Report };
}

/**
 * Fan out an in-app notification to every admin user when a new report comes in.
 * One recipient's failure never aborts notifying the rest.
 */
async function notifyModerators(report: Report): Promise<void> {
  const { data: admins, error } = await supabase.from('users').select('id').eq('role', 'admin');
  if (error || !admins) return;

  for (const admin of admins as Array<{ id: string }>) {
    try {
      const send = await shouldSendInApp(admin.id, 'report_created');
      if (!send) continue;
      await createNotification(admin.id, 'report_created', {
        reportId: report.id,
        targetType: report.target_type,
        targetId: report.target_id,
        reason: report.reason,
      });
    } catch (err) {
      console.error(`[notifyModerators] Failed to notify admin ${admin.id}:`, err);
    }
  }
}

/**
 * Assign a report to a moderator for handling.
 */
export async function assignReport(
  reportId: string,
  moderatorId: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ assigned_to: moderatorId })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Report not found' };

  return { success: true, data: data as Report };
}

/**
 * Set report severity (for triage prioritization).
 */
export async function setSeverity(
  reportId: string,
  severity: ReportSeverity,
): Promise<ServiceResponse<Report>> {
  if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
    return { success: false, error: 'Invalid severity level' };
  }

  const { data, error } = await supabase
    .from('reports')
    .update({ severity })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Report };
}

/**
 * Add evidence to a report (images, screenshots, links).
 */
export async function addEvidence(
  reportId: string,
  evidence: { type: string; url: string; description?: string },
): Promise<ServiceResponse<Report>> {
  // Fetch current report to get existing evidence
  const { data: report } = await supabase
    .from('reports')
    .select('evidence')
    .eq('id', reportId)
    .single();

  if (!report) {
    return { success: false, error: 'Report not found' };
  }

  const currentEvidence = report.evidence || [];
  const updatedEvidence = [...currentEvidence, evidence];

  const { data, error } = await supabase
    .from('reports')
    .update({ evidence: updatedEvidence })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as Report };
}

/** Fetch a report row, or a 404 result when it does not exist. */
async function loadReport(reportId: string): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase.from('reports').select('*').eq('id', reportId).maybeSingle();
  if (error || !data) return { success: false, error: 'Report not found', statusCode: 404 };
  return { success: true, data: data as Report };
}

/** Owner of a listing, or null when the listing does not exist. */
async function getListingOwnerId(propertyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .maybeSingle();
  return (data as { owner_id: string } | null)?.owner_id ?? null;
}

/**
 * Clear a report's hide decision. The listing becomes visible again only when no
 * other report still hides it, so one lifted hide cannot undo another.
 */
async function clearHide(report: Report, actorId: string, auditAction: string): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ hide_property: false })
    .eq('id', report.id)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (report.target_type === 'property' && !(await hasOtherActiveHide(report.target_id, report.id))) {
    const visibility = await setListingModerationState(report.target_id, 'visible');
    if (!visibility.success) return { success: false, error: visibility.error };
  }

  const { record } = await import('./auditLog.service.js');
  await record(actorId, auditAction, 'report', report.id, { listingId: report.target_id });

  return { success: true, data: data as Report };
}

/**
 * Hide a listing from discovery pending review. Records the decision on the
 * report, audits the moderator, and notifies the host without revealing the reporter.
 * Existing bookings are not changed; the listing only stops accepting new ones.
 */
export async function hideProperty(
  reportId: string,
  moderatorId: string,
): Promise<ServiceResponse<Report>> {
  const loaded = await loadReport(reportId);
  if (!loaded.success || !loaded.data) return loaded;
  const report = loaded.data;

  if (report.target_type !== 'property') {
    return { success: false, error: 'Only listings can be hidden', statusCode: 400 };
  }

  const { data, error } = await supabase
    .from('reports')
    .update({ hide_property: true })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const visibility = await setListingModerationState(report.target_id, 'hidden');
  if (!visibility.success) return { success: false, error: visibility.error };

  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, 'listing.hidden', 'report', reportId, { listingId: report.target_id });

  const ownerId = await getListingOwnerId(report.target_id);
  if (ownerId && report.notify_host !== false) {
    await notifyHost(
      reportId,
      ownerId,
      'One of your listings has been hidden from search while it is reviewed. You can submit an appeal.',
    );
  }

  return { success: true, data: data as Report };
}

/**
 * Lift a moderator's hide on a listing. The listing is restored only once no other
 * active hide remains on it.
 */
export async function unhideProperty(
  reportId: string,
  moderatorId: string,
): Promise<ServiceResponse<Report>> {
  const loaded = await loadReport(reportId);
  if (!loaded.success || !loaded.data) return loaded;
  return clearHide(loaded.data, moderatorId, 'listing.unhidden');
}

/**
 * Escalate a pending report to a senior moderator. Records the decision in the audit log.
 */
export async function escalateReport(
  reportId: string,
  moderatorId: string,
  note?: string,
): Promise<ServiceResponse<Report>> {
  const { data, error } = await supabase
    .from('reports')
    .update({ status: 'escalated', resolution_note: note || null })
    .eq('id', reportId)
    .eq('status', 'pending')
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) {
    return { success: false, error: 'Only pending reports can be escalated', statusCode: 409 };
  }

  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, 'report.escalated', 'report', reportId, { resolutionNote: note ?? null });

  return { success: true, data: data as Report };
}

/**
 * Record host notification when report is escalated/resolved.
 */
export async function notifyHost(
  reportId: string,
  hostId: string,
  message: string,
): Promise<ServiceResponse<Report>> {
  // Update report to mark host as notified
  const { data, error } = await supabase
    .from('reports')
    .update({ host_notified: true })
    .eq('id', reportId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Send notification
  try {
    await createNotification(hostId, 'report_notification', {
      reportId,
      message,
    });
  } catch (err) {
    console.error('[notifyHost] Failed to notify host:', err);
  }

  return { success: true, data: data as Report };
}

/**
 * Submit an appeal for a hidden property. Only the listing's owner may appeal,
 * only while the listing is hidden by this report, and only one appeal may be
 * pending at a time.
 */
export async function submitAppeal(
  reportId: string,
  hostId: string,
  appealReason: string,
): Promise<ServiceResponse<Report>> {
  const reason = appealReason.trim();
  if (reason.length === 0 || reason.length > MAX_APPEAL_REASON_LENGTH) {
    return {
      success: false,
      error: `appealReason must be between 1 and ${MAX_APPEAL_REASON_LENGTH} characters`,
      statusCode: 400,
    };
  }

  const loaded = await loadReport(reportId);
  if (!loaded.success || !loaded.data) return loaded;
  const report = loaded.data;

  if (report.target_type !== 'property' || !report.hide_property) {
    return { success: false, error: 'This report is not hiding a listing', statusCode: 409 };
  }

  const ownerId = await getListingOwnerId(report.target_id);
  if (ownerId !== hostId) {
    return { success: false, error: 'Only the listing owner can appeal', statusCode: 403 };
  }

  if (report.appeal_status === 'pending') {
    return { success: false, error: 'An appeal is already pending', statusCode: 409 };
  }
  if (report.appeal_status === 'approved') {
    return { success: false, error: 'This listing has already been restored', statusCode: 409 };
  }

  // Compare-and-set: only move from 'none' or 'denied' so concurrent appeals cannot both land.
  const { data, error } = await supabase
    .from('reports')
    .update({
      appeal_status: 'pending',
      appeal_reason: reason,
    })
    .eq('id', reportId)
    .in('appeal_status', ['none', 'denied'])
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'An appeal is already pending', statusCode: 409 };

  // Notify moderators of appeal
  const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
  if (admins) {
    for (const admin of admins as Array<{ id: string }>) {
      try {
        await createNotification(admin.id, 'appeal_submitted', {
          reportId,
          hostId,
          appealReason,
        });
      } catch {
        // Ignore notification failures
      }
    }
  }

  return { success: true, data: data as Report };
}

/**
 * Approve or deny a pending appeal. Approval restores the listing (subject to other
 * active hides); denial leaves it hidden. The host is told the outcome.
 */
export async function reviewAppeal(
  reportId: string,
  moderatorId: string,
  approved: boolean,
): Promise<ServiceResponse<Report>> {
  const status = approved ? 'approved' : 'denied';

  const loaded = await loadReport(reportId);
  if (!loaded.success || !loaded.data) return loaded;
  const report = loaded.data;

  if (report.appeal_status !== 'pending') {
    return { success: false, error: 'No pending appeal to review', statusCode: 409 };
  }

  // Compare-and-set on 'pending' so a decision is recorded exactly once.
  const { data, error } = await supabase
    .from('reports')
    .update({ appeal_status: status })
    .eq('id', reportId)
    .eq('appeal_status', 'pending')
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'No pending appeal to review', statusCode: 409 };

  let result = data as Report;
  if (approved && report.hide_property) {
    const lifted = await clearHide(report, moderatorId, 'listing.unhidden');
    if (!lifted.success) return lifted;
    result = lifted.data ?? result;
  }

  // Log the decision
  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, `appeal.${status}`, 'report', reportId, {});

  if (report.target_type === 'property') {
    const ownerId = await getListingOwnerId(report.target_id);
    if (ownerId) {
      await notifyHost(
        reportId,
        ownerId,
        approved
          ? 'Your appeal was approved and your listing is visible again.'
          : 'Your appeal was reviewed and the listing remains hidden.',
      );
    }
  }

  return { success: true, data: result };
}

/**
 * Get reports by severity for triage.
 */
export async function getReportsBySeverity(
  severity: ReportSeverity,
): Promise<ServiceResponse<Report[]>> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('severity', severity)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Report[] };
}

/**
 * Get a report's impact — how many reports on this target from different reporters.
 */
export async function getReportImpact(
  targetType: ReportTargetType,
  targetId: string,
): Promise<ServiceResponse<{ count: number; unique_reporters: number }>> {
  const { data, error, count } = await supabase
    .from('reports')
    .select('reporter_id', { count: 'exact' })
    .eq('target_type', targetType)
    .eq('target_id', targetId)
    .eq('status', 'pending');

  if (error) return { success: false, error: error.message };

  const uniqueReporters = data ? new Set((data as { reporter_id: string }[]).map((r) => r.reporter_id)).size : 0;

  return {
    success: true,
    data: {
      count: count ?? 0,
      unique_reporters: uniqueReporters,
    },
  };
}
