import { supabase } from '../config/supabase.js';
import * as cache from './cache.service.js';
import type { ServiceResponse } from './index.js';
import { sanitizeLongText, sanitizeResponse } from '../utils/sanitize.js';
import type { PaginatedResult } from '../types/pagination.js';
import { executePaginatedQuery } from '../utils/pagination.js';

export type ModerationStatus = 'pending' | 'approved' | 'rejected';

/** Granular moderation lifecycle state. */
export type ModerationState =
  | 'none'
  | 'reported'
  | 'under_review'
  | 'action_taken'
  | 'appealed'
  | 'resolved';

/** Visibility state — decoupled from moderation_status. */
export type ReviewVisibility = 'visible' | 'hidden' | 'removed';

/** Appeal tracking states. */
export type AppealStatus = 'none' | 'pending' | 'approved' | 'denied' | 'expired';

export interface Review {
  id: string;
  booking_id: string;
  reviewer_id: string;
  target_id: string;
  property_id?: string;
  rating: number;
  comment?: string;
  on_chain_id?: number;
  host_response?: string;
  host_response_at?: string;
  host_response_version?: number;
  host_response_edit_deadline?: string;
  host_response_mod_status?: 'pending' | 'approved' | 'rejected' | 'removed' | null;
  is_flagged?: boolean;
  flag_reason?: string;
  is_approved?: boolean;
  moderation_status?: ModerationStatus;
  moderation_reason?: string;
  // Enhanced moderation fields
  moderation_state?: ModerationState;
  visibility?: ReviewVisibility;
  original_comment?: string | null;
  original_rating?: number | null;
  moderation_explanation?: string | null;
  moderation_policy_version?: string | null;
  moderation_policy_code?: string | null;
  appeal_deadline?: string | null;
  appeal_reason?: string | null;
  appeal_status?: AppealStatus;
  appeal_decided_at?: string | null;
  appeal_decided_by?: string | null;
  created_at?: string;
}

/** Default appeal window in days from the moderation action. */
const DEFAULT_APPEAL_WINDOW_DAYS = 14;

export async function submitReview(
  bookingId: string,
  reviewerId: string,
  targetId: string,
  rating: number,
  comment: string,
  propertyId?: string,
): Promise<ServiceResponse<Review>> {
  if (rating < 1 || rating > 5) {
    return { success: false, error: 'Rating must be between 1 and 5' };
  }

  // Sanitize user-supplied text; enforce max 2000 chars for review comments.
  // Trim happens inside sanitizeLongText, so validate length on the cleaned
  // value — a whitespace-only comment must be rejected here, not stored as
  // an empty string after the DB round-trip.
  const cleanComment = sanitizeLongText(comment, 2_000);
  if (cleanComment.length === 0) {
    return { success: false, error: 'Comment is required' };
  }

  // Verify booking belongs to reviewer
  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .select('id, status, check_out')
    .eq('id', bookingId)
    .eq('tenant_id', reviewerId)
    .single();

  if (bookingError || !booking) {
    return { success: false, error: 'Booking not found or not owned by reviewer' };
  }

  const b = booking as { id: string; status: string; check_out: string };

  if (b.status === 'Cancelled') {
    return { success: false, error: 'Cannot review a cancelled booking' };
  }
  if (b.status === 'Disputed') {
    return { success: false, error: 'Cannot review a disputed booking' };
  }
  if (b.status !== 'Completed') {
    return { success: false, error: 'Can only review after the stay is completed' };
  }
  if (new Date(b.check_out) >= new Date()) {
    return { success: false, error: 'Cannot review before the checkout date has passed' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      booking_id: bookingId,
      reviewer_id: reviewerId,
      target_id: targetId,
      property_id: propertyId,
      rating,
      comment: cleanComment,
      // Immutable original content snapshots — never modified by moderation.
      original_comment: cleanComment,
      original_rating: rating,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Invalidate the property detail cache so the updated rating aggregate is reflected.
  if (propertyId) {
    await cache.del(`property:${propertyId}`);
  }

  // Notify the host that a new review was submitted
  try {
    const { createNotification } = await import('./notification.service.js');
    const deepLink = propertyId ? `/properties/${propertyId}#reviews` : `/reviews`;
    await createNotification(targetId, 'review_submitted', {
      reviewId: (data as Review).id,
      reviewerId,
      propertyId: propertyId ?? null,
      rating,
      message: `A guest left you a ${rating}-star review.`,
    }, { deepLink });
  } catch {
    // Notification failure must never block the review submission
  }

  return { success: true, data: data as Review };
}

export async function getReviewsForProperty(propertyId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Review>>> {
  const query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('property_id', propertyId)
    .eq('moderation_status', 'approved')
    .eq('visibility', 'visible')
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result! };
}

export async function getReviewsForUser(userId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Review>>> {
  const query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('target_id', userId)
    .eq('moderation_status', 'approved')
    .eq('visibility', 'visible')
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result! };
}

/**
 * Calculate the average rating for a user from only eligible visible reviews.
 *
 * Only reviews with `moderation_status = 'approved'` AND `visibility = 'visible'`
 * are included in the aggregate.  Hidden or removed reviews are excluded so
 * that moderation decisions (hiding a policy-violating review) are reflected
 * in the displayed average.
 */
export async function getAverageRating(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('target_id', userId)
    .eq('is_approved', true)
    .eq('visibility', 'visible');

  if (error) return { success: false, error: error.message };
  // Return zero for both null responses and empty arrays so callers always
  // receive a valid numeric zero rather than NaN for unrated properties.
  if (!data || data.length === 0) return { success: true, data: 0 };

  const rows = data as { rating: number }[];
  const avg = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
  return { success: true, data: Math.round(avg * 10) / 10 };
}

/** How long hosts have to edit their response after first posting (hours). */
const RESPONSE_EDIT_WINDOW_HOURS = 48;

/** Maximum response length (characters). */
const MAX_HOST_RESPONSE_LENGTH = 1000;

/**
 * Add or edit a host response to a review.
 *
 * Rules enforced:
 *  1. Only the property owner (or, for non-property reviews, the target user)
 *     may respond.
 *  2. Exactly one visible response is allowed per review.
 *  3. Edits are permitted within RESPONSE_EDIT_WINDOW_HOURS of the first post.
 *  4. Every version (create + each edit) is appended to review_response_history
 *     as an immutable audit trail.
 *  5. The response enters 'pending' moderation on first create; edits also reset
 *     moderation to 'pending' so moderators review the updated text.
 *  6. The reviewer is notified on first create only (not on edits) to avoid spam.
 */
export async function addHostResponse(
  reviewId: string,
  hostId: string,
  response: string,
): Promise<ServiceResponse<Review>> {
  const cleanResponse = sanitizeResponse(response, MAX_HOST_RESPONSE_LENGTH);
  if (!cleanResponse) {
    return { success: false, error: 'Response text is required' };
  }
  if (cleanResponse.length > MAX_HOST_RESPONSE_LENGTH) {
    return {
      success: false,
      error: `Response must be at most ${MAX_HOST_RESPONSE_LENGTH} characters`,
    };
  }

  const { data: review, error: reviewError } = await supabase
    .from('reviews')
    .select(
      'id, reviewer_id, target_id, property_id, host_response, host_response_version, host_response_edit_deadline, host_response_mod_status',
    )
    .eq('id', reviewId)
    .single();

  if (reviewError || !review) {
    return { success: false, error: 'Review not found' };
  }

  const r = review as {
    id: string;
    reviewer_id: string;
    target_id: string;
    property_id: string | null;
    host_response: string | null;
    host_response_version: number;
    host_response_edit_deadline: string | null;
    host_response_mod_status: string | null;
  };

  // ── Authorization: verify caller owns the reviewed property ─────────────────
  if (r.property_id) {
    const { data: property } = await supabase
      .from('properties')
      .select('owner_id')
      .eq('id', r.property_id)
      .single();

    if (!property || (property as { owner_id: string }).owner_id !== hostId) {
      return { success: false, error: 'Only the property owner can respond to this review' };
    }
  } else if (r.target_id !== hostId) {
    return { success: false, error: 'Only the reviewed host can respond' };
  }

  const isFirstResponse = !r.host_response;
  const now = new Date();

  // ── Edit window enforcement ──────────────────────────────────────────────────
  if (!isFirstResponse) {
    if (!r.host_response_edit_deadline) {
      return { success: false, error: 'This response can no longer be edited' };
    }
    if (now > new Date(r.host_response_edit_deadline)) {
      return {
        success: false,
        error: `Responses can only be edited within ${RESPONSE_EDIT_WINDOW_HOURS} hours of posting`,
      };
    }
    // Removed responses cannot be edited
    if (r.host_response_mod_status === 'removed') {
      return { success: false, error: 'This response has been removed by a moderator' };
    }
  }

  const nextVersion = (r.host_response_version ?? 0) + 1;
  const editDeadline = isFirstResponse
    ? new Date(now.getTime() + RESPONSE_EDIT_WINDOW_HOURS * 3_600_000).toISOString()
    : r.host_response_edit_deadline; // preserve original deadline on edits

  // ── Persist the updated response ─────────────────────────────────────────────
  const { data, error } = await supabase
    .from('reviews')
    .update({
      host_response: cleanResponse,
      host_response_at: isFirstResponse ? now.toISOString() : undefined,
      host_response_version: nextVersion,
      host_response_edit_deadline: editDeadline,
      // Reset moderation to pending on every create/edit
      host_response_mod_status: 'pending',
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Failed to update review response' };

  // ── Append to edit history ────────────────────────────────────────────────────
  await supabase
    .from('review_response_history')
    .insert({
      review_id: reviewId,
      author_id: hostId,
      body: cleanResponse,
      version: nextVersion,
      moderation_status: 'pending',
    })
    .catch((err) =>
      console.error('[review.service] Failed to write response history:', err),
    );

  // ── Notify reviewer on first post only ───────────────────────────────────────
  if (isFirstResponse) {
    try {
      const updatedReview = data as Review;
      const { createNotification } = await import('./notification.service.js');
      await createNotification(updatedReview.reviewer_id, 'host_response', {
        reviewId,
        hostId,
        propertyId: updatedReview.property_id ?? null,
        message: 'The host responded to your review.',
      });
    } catch {
      // Notification failure must never block the host response submission
    }
  }

  return { success: true, data: data as Review };
}

/**
 * Moderate a host response (admin / moderator action).
 *
 * Sets host_response_mod_status.  If the status is 'removed', clears the
 * visible host_response so it no longer renders — but the history row is
 * preserved for audit purposes.
 */
export async function moderateHostResponse(
  reviewId: string,
  status: 'approved' | 'rejected' | 'removed',
  moderatorId: string,
  note?: string,
): Promise<ServiceResponse<Review>> {
  const isRemoval = status === 'removed';

  const { data, error } = await supabase
    .from('reviews')
    .update({
      host_response_mod_status: status,
      // Wipe the visible text on removal; other transitions leave it intact
      ...(isRemoval ? { host_response: null } : {}),
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Update the latest history row with the moderation outcome
  await supabase
    .from('review_response_history')
    .update({
      moderation_status: status,
      moderation_note: note ?? null,
      moderated_by: moderatorId,
      moderated_at: new Date().toISOString(),
    })
    .eq('review_id', reviewId)
    .order('version', { ascending: false })
    .limit(1)
    .catch((err) =>
      console.error('[review.service] Failed to update response history moderation:', err),
    );

  try {
    const { record } = await import('./auditLog.service.js');
    await record(moderatorId, `review.response.${status}`, 'review', reviewId, { note });
  } catch {
    // Audit log failure is non-fatal
  }

  return { success: true, data: data as Review };
}

/**
 * Get the full edit history for a host response (admin view).
 * Returns history rows in ascending version order.
 */
export async function getResponseHistory(
  reviewId: string,
): Promise<ServiceResponse<Array<{
  id: string;
  review_id: string;
  author_id: string;
  body: string;
  version: number;
  moderation_status: string;
  moderation_note: string | null;
  moderated_by: string | null;
  moderated_at: string | null;
  created_at: string;
}>>> {
  const { data, error } = await supabase
    .from('review_response_history')
    .select('*')
    .eq('review_id', reviewId)
    .order('version', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data ?? [] };
}

export async function flagReview(
  reviewId: string,
  reporterId: string,
  reason: string,
): Promise<ServiceResponse<void>> {
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    return { success: false, error: 'Flag reason is required' };
  }

  // Set both the legacy flag fields and the new moderation_state.
  const { error } = await supabase
    .from('reviews')
    .update({
      is_flagged: true,
      flag_reason: trimmedReason,
      moderation_state: 'reported',
    })
    .eq('id', reviewId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function approveReview(
  reviewId: string,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  const { data, error } = await supabase
    .from('reviews')
    .update({
      moderation_status: 'approved',
      is_approved: true,
      is_flagged: false,
      moderation_state: 'resolved',
      visibility: 'visible',
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.approve', 'review', reviewId);
  }

  // Recalculate aggregates for the affected property and user.
  const review = data as Review;
  await recalculateAggregate(review);

  // Notify the reviewer of the decision.
  await notifyModerationDecision(review, 'approved');

  return { success: true, data: review };
}

export async function rejectReview(
  reviewId: string,
  reason: string,
  actorId?: string,
  policyVersion?: string,
  policyCode?: string,
  publicExplanation?: string,
): Promise<ServiceResponse<Review>> {
  if (!reason || reason.trim().length === 0) {
    return { success: false, error: 'Rejection reason is required' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({
      moderation_status: 'rejected',
      is_approved: false,
      moderation_reason: reason,
      is_flagged: false,
      moderation_state: 'action_taken',
      visibility: 'removed',
      ...(policyVersion && { moderation_policy_version: policyVersion }),
      ...(policyCode && { moderation_policy_code: policyCode }),
      ...(publicExplanation && { moderation_explanation: publicExplanation }),
      appeal_deadline: new Date(
        Date.now() + DEFAULT_APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.reject', 'review', reviewId, {
      reason,
      policyVersion,
      policyCode,
    });
  }

  // Recalculate aggregates — the rejected review is now excluded.
  const review = data as Review;
  await recalculateAggregate(review);

  // Notify the reviewer of the decision with a public-facing explanation.
  await notifyModerationDecision(review, 'rejected', publicExplanation);

  return { success: true, data: review };
}

export async function getPendingReviews(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('moderation_status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

export async function moderateReview(
  reviewId: string,
  approve: boolean,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  return approve
    ? approveReview(reviewId, actorId)
    : rejectReview(reviewId, 'Rejected by moderator', actorId);
}

export async function getFlaggedReviews(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('is_flagged', true)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

// ─── Enhanced moderation workflow ────────────────────────────────────────────

/**
 * Structured report for a review with a policy reason code.
 *
 * Unlike the legacy `flagReview`, this records the specific policy reason
 * code, stores the reporter, and sets the moderation state to 'reported'.
 * The original review content is preserved immutably — only visibility and
 * moderation metadata change.
 *
 * @param reviewId   - UUID of the review being reported
 * @param reporterId - UUID of the user filing the report
 * @param reasonCode - Policy reason code (must be a valid code from the
 *                     current moderation policy version)
 * @param details    - Optional free-text explanation from the reporter
 */
export async function reportReview(
  reviewId: string,
  reporterId: string,
  reasonCode: string,
  details?: string,
): Promise<ServiceResponse<Review>> {
  // Fetch the review to verify it exists and get the target_id for notifications.
  const { data: existing, error: fetchError } = await supabase
    .from('reviews')
    .select('id, reviewer_id, target_id, property_id, moderation_state, visibility')
    .eq('id', reviewId)
    .single();

  if (fetchError || !existing) {
    return { success: false, error: 'Review not found' };
  }

  const review = existing as {
    id: string;
    reviewer_id: string;
    target_id: string;
    property_id: string | null;
    moderation_state: ModerationState;
    visibility: ReviewVisibility;
  };

  // Cannot report a review that has already been removed.
  if (review.visibility === 'removed') {
    return { success: false, error: 'This review has been removed and cannot be reported' };
  }

  // Update the review's moderation state and flag fields.
  const { data, error } = await supabase
    .from('reviews')
    .update({
      is_flagged: true,
      flag_reason: reasonCode,
      moderation_state: 'reported',
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const updatedReview = data as Review;

  // Notify moderators via the report_created notification.
  try {
    const { createNotification, shouldSendInApp } = await import('./notification.service.js');
    const { data: admins } = await supabase
      .from('users')
      .select('id')
      .eq('role', 'admin');

    for (const admin of (admins ?? []) as Array<{ id: string }>) {
      const send = await shouldSendInApp(admin.id, 'report_created');
      if (!send) continue;
      await createNotification(admin.id, 'report_created', {
        reviewId,
        reasonCode,
        reporterId,
        targetType: 'review',
        targetId: reviewId,
      }, { deepLink: `/admin/moderation/reviews/${reviewId}` });
    }
  } catch {
    // Notification failures are non-blocking
  }

  return { success: true, data: updatedReview };
}

/**
 * Start moderation review — sets the review to 'under_review' state.
 * Only works on reviews in 'reported' or 'action_taken' state.
 */
export async function startModeration(
  reviewId: string,
  moderatorId: string,
): Promise<ServiceResponse<Review>> {
  // Verify the review exists and is in a valid state for moderation.
  const { data: existing } = await supabase
    .from('reviews')
    .select('moderation_state')
    .eq('id', reviewId)
    .single();

  if (!existing) {
    return { success: false, error: 'Review not found' };
  }

  const currentState = (existing as { moderation_state: ModerationState }).moderation_state;
  if (currentState !== 'reported' && currentState !== 'action_taken' && currentState !== 'none') {
    return { success: false, error: `Cannot start moderation on a review in "${currentState}" state` };
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({ moderation_state: 'under_review' })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, 'review.start_moderation', 'review', reviewId);

  return { success: true, data: data as Review };
}

/**
 * Take a moderation action on a review.
 *
 * Actions:
 *   - 'hide'    — set visibility to 'hidden' (review exists but isn't shown)
 *   - 'remove'  — set visibility to 'removed' (review is fully removed)
 *   - 'keep'    — approve and keep visible (clears the flag)
 *
 * The original review content (original_comment, original_rating) is never
 * modified — only visibility and moderation metadata change.
 *
 * @param reviewId          - UUID of the review
 * @param moderatorId       - UUID of the moderator
 * @param action            - 'hide' | 'remove' | 'keep'
 * @param policyVersion     - Moderation policy version in effect
 * @param policyCode        - Reason code from the policy
 * @param publicExplanation - User-facing explanation (no confidential notes)
 */
export async function takeModerationAction(
  reviewId: string,
  moderatorId: string,
  action: 'hide' | 'remove' | 'keep',
  policyVersion: string,
  policyCode: string,
  publicExplanation?: string,
): Promise<ServiceResponse<Review>> {
  const updatePayload: Record<string, unknown> = {
    moderation_state: 'action_taken',
    moderation_policy_version: policyVersion,
    moderation_policy_code: policyCode,
  };

  if (action === 'hide') {
    updatePayload.visibility = 'hidden';
    updatePayload.moderation_status = 'pending'; // stays pending while hidden
    updatePayload.is_approved = false;
  } else if (action === 'remove') {
    updatePayload.visibility = 'removed';
    updatePayload.moderation_status = 'rejected';
    updatePayload.is_approved = false;
    updatePayload.is_flagged = false;
    updatePayload.moderation_reason = policyCode;
    // Set appeal deadline
    updatePayload.appeal_deadline = new Date(
      Date.now() + DEFAULT_APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
  } else {
    // 'keep' — approve and make visible
    updatePayload.visibility = 'visible';
    updatePayload.moderation_status = 'approved';
    updatePayload.is_approved = true;
    updatePayload.is_flagged = false;
    updatePayload.moderation_state = 'resolved';
  }

  if (publicExplanation) {
    updatePayload.moderation_explanation = publicExplanation;
  }

  const { data, error } = await supabase
    .from('reviews')
    .update(updatePayload)
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Review not found' };

  const review = data as Review;

  // Audit log — confidential moderator context goes here, not to users.
  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, `review.${action}`, 'review', reviewId, {
    policyVersion,
    policyCode,
    action,
  });

  // Recalculate aggregates — hidden/removed reviews are excluded.
  await recalculateAggregate(review);

  // Notify the reviewer and the reviewed host of the decision.
  const decisionLabel = action === 'keep' ? 'approved' : action === 'hide' ? 'hidden' : 'removed';
  await notifyModerationDecision(review, decisionLabel, publicExplanation);

  return { success: true, data: review };
}

/**
 * Submit an appeal for a moderation decision.
 *
 * Validates that:
 *   - The review has a moderation action taken (state = 'action_taken')
 *   - The appeal deadline has not passed
 *   - No existing appeal is pending
 *
 * @param reviewId    - UUID of the review
 * @param appellantId - UUID of the user appealing (should be the reviewer)
 * @param reason      - Appeal reason text
 */
export async function submitAppeal(
  reviewId: string,
  appellantId: string,
  reason: string,
): Promise<ServiceResponse<Review>> {
  const trimmedReason = reason?.trim();
  if (!trimmedReason) {
    return { success: false, error: 'Appeal reason is required' };
  }

  const { data: existing, error: fetchError } = await supabase
    .from('reviews')
    .select('id, reviewer_id, target_id, moderation_state, appeal_status, appeal_deadline')
    .eq('id', reviewId)
    .single();

  if (fetchError || !existing) {
    return { success: false, error: 'Review not found' };
  }

  const review = existing as {
    id: string;
    reviewer_id: string;
    target_id: string;
    moderation_state: ModerationState;
    appeal_status: AppealStatus;
    appeal_deadline: string | null;
  };

  // Only the reviewer (author) can appeal.
  if (review.reviewer_id !== appellantId) {
    return { success: false, error: 'Only the review author can appeal this decision' };
  }

  // Must have had an action taken to appeal.
  if (review.moderation_state !== 'action_taken' && review.moderation_state !== 'resolved') {
    return { success: false, error: 'This review has no moderation action to appeal' };
  }

  // Check for existing pending appeal.
  if (review.appeal_status === 'pending') {
    return { success: false, error: 'An appeal is already pending for this review' };
  }
  if (review.appeal_status === 'approved' || review.appeal_status === 'denied') {
    return { success: false, error: 'This review has already been appealed and resolved' };
  }

  // Check the appeal deadline.
  if (review.appeal_deadline) {
    if (new Date(review.appeal_deadline) < new Date()) {
      // Mark the appeal as expired.
      await supabase
        .from('reviews')
        .update({ appeal_status: 'expired' })
        .eq('id', reviewId);
      return { success: false, error: 'The appeal deadline has passed' };
    }
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({
      moderation_state: 'appealed',
      appeal_status: 'pending',
      appeal_reason: trimmedReason,
    })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Notify moderators of the appeal.
  try {
    const { createNotification } = await import('./notification.service.js');
    const { data: admins } = await supabase.from('users').select('id').eq('role', 'admin');
    for (const admin of (admins ?? []) as Array<{ id: string }>) {
      await createNotification(admin.id, 'appeal_submitted', {
        reviewId,
        appellantId,
        reason: trimmedReason,
      }, { deepLink: `/admin/moderation/appeals/${reviewId}` }).catch(() => {});
    }
  } catch {
    // Non-blocking
  }

  return { success: true, data: data as Review };
}

/**
 * Resolve an appeal — approve or deny it.
 *
 * If approved:
 *   - Restore the review to visible
 *   - Set moderation_state to 'resolved'
 *   - Set appeal_status to 'approved'
 *
 * If denied:
 *   - Keep the current visibility
 *   - Set moderation_state to 'resolved'
 *   - Set appeal_status to 'denied'
 *
 * @param reviewId     - UUID of the review
 * @param moderatorId  - UUID of the moderator
 * @param approved     - Whether the appeal is approved
 */
export async function resolveAppeal(
  reviewId: string,
  moderatorId: string,
  approved: boolean,
): Promise<ServiceResponse<Review>> {
  const { data: existing } = await supabase
    .from('reviews')
    .select('id, reviewer_id, target_id, appeal_status, visibility')
    .eq('id', reviewId)
    .single();

  if (!existing) {
    return { success: false, error: 'Review not found' };
  }

  const review = existing as {
    id: string;
    reviewer_id: string;
    target_id: string;
    appeal_status: AppealStatus;
    visibility: ReviewVisibility;
  };

  if (review.appeal_status !== 'pending') {
    return { success: false, error: 'No pending appeal to resolve' };
  }

  const updatePayload: Record<string, unknown> = {
    moderation_state: 'resolved',
    appeal_status: approved ? 'approved' : 'denied',
    appeal_decided_at: new Date().toISOString(),
    appeal_decided_by: moderatorId,
  };

  // If the appeal is approved, restore visibility.
  if (approved) {
    updatePayload.visibility = 'visible';
    updatePayload.moderation_status = 'approved';
    updatePayload.is_approved = true;
    updatePayload.is_flagged = false;
  }

  const { data, error } = await supabase
    .from('reviews')
    .update(updatePayload)
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const updatedReview = data as Review;

  // Audit log the appeal decision.
  const { record } = await import('./auditLog.service.js');
  await record(moderatorId, `appeal.${approved ? 'approved' : 'denied'}`, 'review', reviewId);

  // Recalculate aggregates since visibility may have changed.
  await recalculateAggregate(updatedReview);

  // Notify the reviewer of the appeal outcome.
  try {
    const { createNotification } = await import('./notification.service.js');
    const deepLink = updatedReview.property_id
      ? `/properties/${updatedReview.property_id}#reviews`
      : `/reviews/${reviewId}`;
    const message = approved
      ? 'Your appeal has been approved. Your review is visible again.'
      : 'Your appeal has been denied. The moderation decision stands.';
    await createNotification(updatedReview.reviewer_id, 'moderation_decision', {
      reviewId,
      appealApproved: approved,
      message,
    }, { deepLink });
  } catch {
    // Non-blocking
  }

  return { success: true, data: updatedReview };
}

/**
 * Get reviews in the moderation queue (reported, under_review, or appealed).
 * Admin-only.
 */
export async function getModerationQueue(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .in('moderation_state', ['reported', 'under_review', 'appealed', 'action_taken'])
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

/**
 * Get reviews with pending appeals.
 * Admin-only.
 */
export async function getPendingAppeals(): Promise<ServiceResponse<Review[]>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('appeal_status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Review[] };
}

// ─── Aggregate recalculation ──────────────────────────────────────────────────

/**
 * Recalculate the rating aggregate for a property after a moderation action.
 *
 * Only reviews with `moderation_status = 'approved'` AND `visibility = 'visible'`
 * are included.  Invalidates the property cache so the updated aggregate is
 * reflected on the next read.
 *
 * This function does NOT modify the on-chain reputation — that is computed
 * by the Soroban contract and is immutable.  The off-chain aggregate is a
 * projection used for display; it reflects moderation decisions.
 */
async function recalculateAggregate(review: Review): Promise<void> {
  if (review.property_id) {
    // Invalidate the property detail cache.
    await cache.del(`property:${review.property_id}`);
  }

  // Invalidate any user-level rating cache.
  if (review.target_id) {
    await cache.del(`user_rating:${review.target_id}`);
  }
}

/**
 * Send a moderation decision notification to the reviewer.
 *
 * The notification includes a public-facing explanation (if provided) but
 * never includes confidential moderator notes.  Those are in audit_logs only.
 */
async function notifyModerationDecision(
  review: Review,
  decision: string,
  publicExplanation?: string,
): Promise<void> {
  try {
    const { createNotification } = await import('./notification.service.js');
    const deepLink = review.property_id
      ? `/properties/${review.property_id}#reviews`
      : `/reviews/${review.id}`;

    const message = publicExplanation
      ? `Your review has been ${decision}. ${publicExplanation}`
      : `Your review has been ${decision}.`;

    await createNotification(review.reviewer_id, 'moderation_decision', {
      reviewId: review.id,
      decision,
      message,
    }, { deepLink });
  } catch {
    // Non-blocking
  }
}
