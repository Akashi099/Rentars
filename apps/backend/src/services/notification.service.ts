import { supabase } from '../config/supabase.js';
import { emailService } from './email.service.js';
import { buildPreferenceUrlForUser } from './preferenceToken.js';
import type { ServiceResponse } from './index.js';
import { decodeCursor, buildCursorPage } from '../utils/cursor.js';
import type { PaginatedResult } from '../types/pagination.js';
import { executePaginatedQuery } from '../utils/pagination.js';

export interface CursorPaginatedResult<T> {
  data: T[];
  nextCursor: string | null;
}

export type NotificationType =
  | 'booking_created'
  | 'booking_confirmed'
  | 'booking_cancelled'
  | 'booking_completed'
  | 'booking_disputed'
  | 'booking_expired'
  | 'booking_modification_requested'
  | 'booking_modification_accepted'
  | 'booking_modification_declined'
  | 'payment_received'
  | 'booking_reminder'
  | 'review_requested'
  | 'review_submitted'
  | 'host_response'
  | 'dispute_initiated'
  | 'new_property'
  | 'system_alert'
  | 'report_created'
  | 'message_received'
  | 'appeal_submitted'
  | 'report_notification'
  | 'moderation_decision';

/** Coarse bucket used for filtering the notification list. */
export type NotificationCategory =
  | 'booking'
  | 'payment'
  | 'review'
  | 'dispute'
  | 'message'
  | 'moderation'
  | 'social'
  | 'system';

export const VALID_NOTIFICATION_CATEGORIES: ReadonlyArray<NotificationCategory> = [
  'booking',
  'payment',
  'review',
  'dispute',
  'message',
  'moderation',
  'social',
  'system',
];

/**
 * Map a notification type to its coarse category bucket.
 * This mapping is the single source of truth — the DB migration backfill
 * uses the same CASE logic.
 */
export function categoryForType(type: NotificationType): NotificationCategory {
  switch (type) {
    case 'booking_created':
    case 'booking_confirmed':
    case 'booking_cancelled':
    case 'booking_completed':
    case 'booking_expired':
    case 'booking_reminder':
    case 'booking_modification_requested':
    case 'booking_modification_accepted':
    case 'booking_modification_declined':
      return 'booking';
    case 'payment_received':
      return 'payment';
    case 'review_requested':
    case 'review_submitted':
    case 'host_response':
      return 'review';
    case 'dispute_initiated':
    case 'booking_disputed':
      return 'dispute';
    case 'message_received':
      return 'message';
    case 'report_created':
    case 'moderation_decision':
    case 'appeal_submitted':
    case 'report_notification':
      return 'moderation';
    case 'new_property':
      return 'social';
    default:
      return 'system';
  }
}

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  read: boolean;
  category?: NotificationCategory;
  deep_link?: string | null;
  event_id?: string | null;
  expires_at?: string | null;
  created_at?: string;
}

export interface NotificationPreferences {
  id?: string;
  user_id: string;
  email_notifications: boolean;
  push_notifications: boolean;
  notification_types: Partial<Record<NotificationType, boolean>>;
  /** Wall-clock start of the quiet window, e.g. '22:00'. Null = no quiet window. */
  quiet_hours_start?: string | null;
  /** Wall-clock end of the quiet window, e.g. '08:00'. May wrap past midnight. */
  quiet_hours_end?: string | null;
  /** IANA timezone used when evaluating the quiet window. Defaults to UTC. */
  quiet_hours_timezone?: string | null;
  updated_at?: string;
}

export interface ScheduledNotification {
  userId: string;
  type: NotificationType;
  data: Record<string, unknown>;
  sendAfter: Date;
}

const EMAIL_TEMPLATES: Partial<Record<NotificationType, string>> = {
  booking_created: 'Booking Created',
  booking_confirmed: 'Booking Confirmed',
  booking_cancelled: 'Booking Cancelled',
  booking_modification_requested: 'Booking Modification Requested',
  booking_modification_accepted: 'Booking Modification Accepted',
  booking_modification_declined: 'Booking Modification Declined',
  payment_received: 'Payment Received',
  booking_reminder: 'Booking Reminder',
  review_requested: 'Review Requested',
  review_submitted: 'New Review Submitted',
  host_response: 'Host Responded to Your Review',
  dispute_initiated: 'Dispute Initiated',
  new_property: 'New Listing from a Host You Follow',
  system_alert: 'System Alert',
  report_created: 'New Report Submitted',
  message_received: 'New Message',
};

const VALID_NOTIFICATION_TYPES: ReadonlyArray<NotificationType> = [
  'booking_created',
  'booking_confirmed',
  'booking_cancelled',
  'booking_completed',
  'booking_disputed',
  'booking_expired',
  'booking_modification_requested',
  'booking_modification_accepted',
  'booking_modification_declined',
  'payment_received',
  'booking_reminder',
  'review_requested',
  'review_submitted',
  'host_response',
  'dispute_initiated',
  'new_property',
  'system_alert',
  'report_created',
  'message_received',
  'appeal_submitted',
  'report_notification',
  'moderation_decision',
];

/**
 * Keys that are stripped from notification `data` payloads when returning
 * list responses.  This prevents sensitive fields (email addresses, internal
 * error details, wallet addresses, amounts) from leaking through list endpoints.
 * Individual notification detail views may still expose safe fields.
 */
const SENSITIVE_DATA_KEYS = [
  'userEmail',
  'userName',
  'walletAddress',
  'errorDetails',
  'internalNote',
  'supportLink',
  'attempt',
  'audience',
] as const;

/**
 * Return a sanitised copy of the notification data with sensitive keys removed.
 * Applied to every notification in list responses.
 */
function sanitizeDataForList(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SENSITIVE_DATA_KEYS.includes(key as (typeof SENSITIVE_DATA_KEYS)[number])) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Apply list-safe sanitisation to a single notification row.
 */
function sanitizeNotificationForList(n: Notification): Notification {
  return {
    ...n,
    data: sanitizeDataForList(n.data ?? {}),
  };
}

/**
 * Invalidate the notification cache for a user after a mutation.
 * Cache keys follow the pattern `notifications:<userId>`.
 */
async function invalidateNotificationCache(userId: string): Promise<void> {
  try {
    const { invalidatePattern } = await import('./cache.service.js');
    await invalidatePattern(`notifications:${userId}`);
  } catch {
    // Cache miss is non-fatal
  }
}

/** Options for creating a notification. */
export interface CreateNotificationOptions {
  /** Client-side route the app navigates to on tap. */
  deepLink?: string;
  /** Stable event identifier for dedup — prevents duplicate notifications for the same logical event. */
  eventId?: string;
  /** Optional retention cutoff; the notification is auto-deleted after this timestamp. */
  expiresAt?: string;
}

export async function createNotification(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  options?: CreateNotificationOptions,
): Promise<ServiceResponse<Notification>> {
  if (!VALID_NOTIFICATION_TYPES.includes(type)) {
    return { success: false, error: `Unknown notification type: ${type}` };
  }

  const category = categoryForType(type);

  // Event ID dedup: if an event_id is provided, check for an existing
  // notification with the same (user_id, event_id).  If found, return it
  // idempotently instead of creating a duplicate.
  if (options?.eventId) {
    const { data: existing } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .eq('event_id', options.eventId)
      .maybeSingle();

    if (existing) {
      return { success: true, data: existing as Notification };
    }
  }

  const insertPayload: Record<string, unknown> = {
    user_id: userId,
    type,
    data,
    category,
    ...(options?.deepLink && { deep_link: options.deepLink }),
    ...(options?.eventId && { event_id: options.eventId }),
    ...(options?.expiresAt && { expires_at: options.expiresAt }),
  };

  const { data: notification, error } = await supabase
    .from('notifications')
    .insert(insertPayload)
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Invalidate the notification cache so the next list request sees the new row.
  await invalidateNotificationCache(userId);

  return { success: true, data: notification as Notification };
}

export async function getNotifications(
  userId: string,
  page = 1,
  pageSize = 20,
  category?: NotificationCategory | null,
): Promise<ServiceResponse<PaginatedResult<Notification>>> {
  let query = supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (category && VALID_NOTIFICATION_CATEGORIES.includes(category)) {
    query = query.eq('category', category);
  }

  const response = await executePaginatedQuery(query, page, Math.min(Math.max(1, pageSize), 100));
  if (response.error) return { success: false, error: response.error };

  // Sanitise sensitive fields out of the list payload.
  const sanitized = response.result!.data.map(sanitizeNotificationForList);
  return { success: true, data: { ...response.result!, data: sanitized } };
}

/**
 * Cursor-based paginated notification list.
 *
 * Sort key: (created_at DESC, id DESC) — stable even under concurrent inserts.
 * We fetch limit+1 rows so we can detect whether a next page exists.
 *
 * @param userId   - The authenticated user's ID
 * @param cursor   - Opaque cursor returned from a previous call (omit for first page)
 * @param limit    - Page size, default 20, max 100
 * @param category - Optional category filter
 */
export async function getNotificationsCursor(
  userId: string,
  cursor?: string | null,
  limit = 20,
  category?: NotificationCategory | null,
): Promise<ServiceResponse<CursorPaginatedResult<Notification>>> {
  // Reject non-finite or fractional limits so the service never passes an
  // unexpected page size to Supabase. Valid integers are clamped to [1, 100].
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) {
    return { success: false, error: 'limit must be a finite integer' };
  }

  const pageSize = Math.min(Math.max(1, limit), 100);
  const decoded = decodeCursor(cursor);

  let query = supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(pageSize + 1); // +1 to detect hasMore

  if (category && VALID_NOTIFICATION_CATEGORIES.includes(category)) {
    query = query.eq('category', category);
  }

  if (decoded) {
    // Keyset filter: rows strictly after the cursor position
    // (created_at < cursor.created_at) OR (created_at = cursor.created_at AND id < cursor.id)
    query = query.or(
      `created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.lt.${decoded.id})`,
    );
  }

  const { data, error } = await query;

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as Notification[];
  const page = buildCursorPage(rows, pageSize);

  // Sanitise sensitive fields out of the list payload.
  const sanitizedData = page.data.map(sanitizeNotificationForList);

  return { success: true, data: { ...page, data: sanitizedData } };
}

export async function markAsRead(
  notificationId: string,
  userId: string
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('id', notificationId)
    .eq('user_id', userId);

  if (error) return { success: false, error: error.message };

  await invalidateNotificationCache(userId);
  return { success: true };
}

/**
 * Mark a specific set of notifications as read for the authenticated user.
 *
 * Authorization: the `eq('user_id', userId)` filter ensures a user can only
 * mark their own notifications.  Idempotent — already-read rows are
 * unaffected by the UPDATE.
 *
 * @param userId          - The authenticated user's ID (authorization scope)
 * @param notificationIds - Array of notification UUIDs to mark as read
 * @returns               - Count of notifications actually updated
 */
export async function bulkMarkAsRead(
  userId: string,
  notificationIds: string[],
): Promise<ServiceResponse<{ updated: number }>> {
  if (!userId || !userId.trim()) {
    return { success: false, error: 'user_id is required' };
  }
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return { success: false, error: 'notificationIds must be a non-empty array' };
  }
  // Cap the batch size to prevent abuse.
  if (notificationIds.length > 500) {
    return { success: false, error: 'Cannot mark more than 500 notifications at once' };
  }

  // The eq('user_id', userId) clause is the authorization boundary —
  // even if an attacker passes another user's notification IDs, the update
  // will not affect them.
  const { data, error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', userId)
    .in('id', notificationIds)
    .select('id');

  if (error) return { success: false, error: error.message };

  await invalidateNotificationCache(userId);
  return { success: true, data: { updated: data?.length ?? 0 } };
}

export async function markAllAsRead(userId: string): Promise<ServiceResponse<void>> {
  if (!userId || !userId.trim()) {
    return { success: false, error: 'user_id is required' };
  }

  const { error } = await supabase
    .from('notifications')
    .update({ read: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (error) return { success: false, error: error.message };

  await invalidateNotificationCache(userId);
  return { success: true };
}

export async function deleteNotification(
  notificationId: string,
  userId: string
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('notifications')
    .delete()
    .eq('id', notificationId)
    .eq('user_id', userId);

  if (error) return { success: false, error: error.message };

  await invalidateNotificationCache(userId);
  return { success: true };
}

export async function deleteAllNotifications(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) return { success: false, error: error.message };

  await invalidateNotificationCache(userId);
  return { success: true, data: data?.length ?? 0 };
}

/**
 * Get the count of unread notifications for a user.
 * Used by the UI to display a badge.
 */
export async function getUnreadCount(userId: string): Promise<ServiceResponse<number>> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (error) return { success: false, error: error.message };
  return { success: true, data: count ?? 0 };
}

/**
 * Delete notifications that have passed their retention cutoff.
 *
 * This function is designed to be called by a scheduled job / cron.
 * Only rows with a non-null `expires_at` that is in the past are deleted.
 *
 * @returns Count of deleted notifications.
 */
export async function cleanupExpiredNotifications(): Promise<ServiceResponse<number>> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .lt('expires_at', now)
    .select('id');

  if (error) return { success: false, error: error.message };

  const deleted = data?.length ?? 0;
  if (deleted > 0) {
    console.info(`[NotificationService] Cleaned up ${deleted} expired notifications`);
  }

  return { success: true, data: deleted };
}

export async function getPreferences(
  userId: string
): Promise<ServiceResponse<NotificationPreferences>> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  if (!data) {
    const defaults: NotificationPreferences = {
      user_id: userId,
      email_notifications: true,
      push_notifications: true,
      notification_types: {},
      quiet_hours_start: null,
      quiet_hours_end: null,
      quiet_hours_timezone: null,
    };
    return { success: true, data: defaults };
  }

  return { success: true, data: data as NotificationPreferences };
}

export async function updatePreferences(
  userId: string,
  prefs: Partial<Omit<NotificationPreferences, 'user_id' | 'id'>>
): Promise<ServiceResponse<NotificationPreferences>> {
  const { data, error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId, ...prefs, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as NotificationPreferences };
}

async function shouldSendEmail(userId: string, type: NotificationType): Promise<boolean> {
  const prefsResult = await getPreferences(userId);
  if (!prefsResult.success || !prefsResult.data) return true;
  const prefs = prefsResult.data;
  if (!prefs.email_notifications) return false;
  const typeEnabled = prefs.notification_types[type];
  return typeEnabled !== false;
}

async function shouldSendPush(userId: string, type: NotificationType): Promise<boolean> {
  const prefsResult = await getPreferences(userId);
  if (!prefsResult.success || !prefsResult.data) return true;
  const prefs = prefsResult.data;
  if (!prefs.push_notifications) return false;
  const typeEnabled = prefs.notification_types[type];
  return typeEnabled !== false;
}

export async function shouldSendInApp(userId: string, type: NotificationType): Promise<boolean> {
  const prefsResult = await getPreferences(userId);
  if (!prefsResult.success || !prefsResult.data) return true;
  const prefs = prefsResult.data;
  const typeEnabled = prefs.notification_types[type];
  return typeEnabled !== false;
}

export async function createNotificationWithEmail(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  options?: CreateNotificationOptions,
): Promise<ServiceResponse<Notification>> {
  const result = await createNotification(userId, type, data, options);
  if (!result.success) return result;

  const sendEmail = await shouldSendEmail(userId, type);
  if (sendEmail && data.userEmail) {
    // Generate a per-recipient preference management URL so recipients can
    // manage or unsubscribe directly from the email footer.
    const preferencesUrl = buildPreferenceUrlForUser(userId);

    const emailData = {
      to: String(data.userEmail),
      userName: String(data.userName ?? ''),
      propertyTitle: String(data.propertyTitle ?? ''),
      checkIn: String(data.checkIn ?? ''),
      checkOut: String(data.checkOut ?? ''),
      totalPrice: Number(data.totalPrice ?? 0),
      preferencesUrl,
    };

    const emailPromise =
      type === 'booking_created'
        ? emailService.sendBookingCreated(emailData)
        : type === 'booking_confirmed'
          ? emailService.sendBookingConfirmed(emailData)
          : type === 'booking_cancelled'
            ? emailService.sendBookingCancelled(emailData)
            : Promise.resolve();

    await emailPromise.catch((err) =>
      console.error(`[NotificationService] Email send failed for type ${type}:`, err)
    );
  }

  return result;
}

export async function sendBatchedNotifications(
  notifications: ScheduledNotification[]
): Promise<ServiceResponse<number>> {
  const now = new Date();
  const due = notifications.filter((n) => n.sendAfter <= now);

  let sent = 0;
  for (const n of due) {
    const result = await createNotificationWithEmail(n.userId, n.type, n.data);
    if (result.success) sent++;
  }

  return { success: true, data: sent };
}

export async function createNotificationWithAllChannels(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  options?: CreateNotificationOptions,
): Promise<ServiceResponse<void>> {
  const inAppResult = await createNotification(userId, type, data, options);
  if (!inAppResult.success) {
    return { success: false, error: inAppResult.error };
  }

  const emailShouldSend = await shouldSendEmail(userId, type);
  if (emailShouldSend && data.userEmail) {
    const emailData = {
      to: String(data.userEmail),
      userName: String(data.userName ?? ''),
      propertyTitle: String(data.propertyTitle ?? ''),
      checkIn: String(data.checkIn ?? ''),
      checkOut: String(data.checkOut ?? ''),
      totalPrice: Number(data.totalPrice ?? 0),
    };

    const emailPromise =
      type === 'booking_created'
        ? emailService.sendBookingCreated(emailData)
        : type === 'booking_confirmed'
          ? emailService.sendBookingConfirmed(emailData)
          : type === 'booking_cancelled'
            ? emailService.sendBookingCancelled(emailData)
            : Promise.resolve();

    await emailPromise.catch((err) =>
      console.error(`[NotificationService] Email send failed for type ${type}:`, err)
    );
  }

  return { success: true };
}

export { EMAIL_TEMPLATES };

// ─── Host-follow new-listing fan-out ──────────────────────────────────────────

export interface NewPropertyNotificationData {
  /** UUID of the newly published property. */
  propertyId: string;
  /** Human-readable title for the notification body. */
  propertyTitle: string;
  /** URL slug — used to build the deep-link in the notification. */
  propertySlug: string;
  /** UUID of the host who published the property. */
  hostId: string;
  /** Display name of the host (shown in notification body). */
  hostName: string;
}

/**
 * Fan-out a `new_property` notification to every follower of `hostId`.
 *
 * Each follower's notification preferences are respected:
 *  - If the follower has disabled `new_property` notifications (or all
 *    in-app notifications) the in-app row is skipped.
 *  - Email fan-out is intentionally NOT performed here to avoid large
 *    synchronous email bursts; wire a background job / queue if needed.
 *
 * Failures for individual followers are logged but do not abort the
 * overall fan-out so one bad row never blocks the rest.
 *
 * @param data  - Property and host metadata for the notification payload.
 * @returns     - Count of notifications successfully created.
 */
export async function notifyHostFollowers(
  data: NewPropertyNotificationData,
): Promise<ServiceResponse<{ notified: number }>> {
  const { getHostFollowerIds } = await import('./follow.service.js');

  const followersResult = await getHostFollowerIds(data.hostId);
  if (!followersResult.success) {
    return { success: false, error: followersResult.error };
  }

  const followerIds = followersResult.data ?? [];
  if (followerIds.length === 0) {
    return { success: true, data: { notified: 0 } };
  }

  const payload: Record<string, unknown> = {
    propertyId:    data.propertyId,
    propertyTitle: data.propertyTitle,
    propertySlug:  data.propertySlug,
    hostId:        data.hostId,
    hostName:      data.hostName,
  };

  // Deep link to the property listing page.
  const deepLink = data.propertySlug
    ? `/properties/${data.propertySlug}`
    : `/properties/${data.propertyId}`;

  let notified = 0;

  for (const followerId of followerIds) {
    try {
      // Respect per-user in-app notification preferences
      const send = await shouldSendInApp(followerId, 'new_property');
      if (!send) continue;

      // Use a per-follower event_id so retries don't create duplicates.
      const eventId = `new_property:${data.propertyId}:${followerId}`;
      const result = await createNotification(followerId, 'new_property', payload, {
        deepLink,
        eventId,
      });
      if (result.success) notified++;
    } catch (err) {
      // Log and continue — one follower's failure must not abort the fan-out
      console.error(
        `[notifyHostFollowers] Failed to notify follower ${followerId}:`,
        err,
      );
    }
  }

  return { success: true, data: { notified } };
}
