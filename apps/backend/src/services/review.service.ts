import { supabase } from '../config/supabase.js';
import * as cache from './cache.service.js';
import type { ServiceResponse } from './index.js';
import { sanitizeLongText, sanitizeResponse } from '../utils/sanitize.js';
import type { PaginatedResult } from '../types/pagination.js';
import { executePaginatedQuery } from '../utils/pagination.js';

export type ModerationStatus = 'pending' | 'approved' | 'rejected';

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
  created_at?: string;
}

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
    await createNotification(targetId, 'review_submitted', {
      reviewId: (data as Review).id,
      reviewerId,
      propertyId: propertyId ?? null,
      rating,
      message: `A guest left you a ${rating}-star review.`,
    });
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
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

export async function getReviewsForUser(userId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Review>>> {
  const query = supabase
    .from('reviews')
    .select('*', { count: 'exact' })
    .eq('target_id', userId)
    .eq('moderation_status', 'approved')
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

export async function getAverageRating(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('rating')
    .eq('target_id', userId)
    .eq('is_approved', true);

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

  const { error } = await supabase
    .from('reviews')
    .update({ is_flagged: true, flag_reason: trimmedReason })
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
    .update({ moderation_status: 'approved', is_approved: true, is_flagged: false })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.approve', 'review', reviewId);
  }

  return { success: true, data: data as Review };
}

export async function rejectReview(
  reviewId: string,
  reason: string,
  actorId?: string,
): Promise<ServiceResponse<Review>> {
  if (!reason || reason.trim().length === 0) {
    return { success: false, error: 'Rejection reason is required' };
  }

  const { data, error } = await supabase
    .from('reviews')
    .update({ moderation_status: 'rejected', is_approved: false, moderation_reason: reason, is_flagged: false })
    .eq('id', reviewId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  if (actorId) {
    const { record } = await import('./auditLog.service.js');
    await record(actorId, 'review.reject', 'review', reviewId, { reason });
  }

  return { success: true, data: data as Review };
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
