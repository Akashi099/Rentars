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
  | 'message_received';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  read: boolean;
  idempotency_key?: string | null;
  created_at?: string;
}

export interface NotificationPreferences {
  id?: string;
  user_id: string;
  email_notifications: boolean;
  push_notifications: boolean;
  notification_types: Partial<Record<NotificationType, boolean>>;
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
];

export async function createNotification(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<ServiceResponse<Notification>> {
  if (!VALID_NOTIFICATION_TYPES.includes(type)) {
    return { success: false, error: `Unknown notification type: ${type}` };
  }

  const row = {
    user_id: userId,
    type,
    data,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
  const { data: notification, error } = await (
    idempotencyKey
      ? supabase
          .from('notifications')
          .upsert(row, { onConflict: 'user_id,idempotency_key', ignoreDuplicates: true })
          .select()
          .maybeSingle()
      : supabase
          .from('notifications')
          .insert(row)
          .select()
          .single()
  );

  if (error) return { success: false, error: error.message };
  if (notification) return { success: true, data: notification as Notification };

  const { data: existing, error: lookupError } = await supabase
    .from('notifications')
    .select()
    .eq('user_id', userId)
    .eq('idempotency_key', idempotencyKey!)
    .single();
  if (lookupError || !existing) {
    return { success: false, error: lookupError?.message ?? 'Idempotent notification could not be loaded' };
  }
  return { success: true, data: existing as Notification };
}

export async function enqueueNotificationOutbox(
  userId: string,
  type: NotificationType,
  data: Record<string, unknown>,
  dedupeKey: string,
): Promise<ServiceResponse<void>> {
  if (!userId || !dedupeKey) {
    return { success: false, error: 'userId and dedupeKey are required' };
  }
  if (!VALID_NOTIFICATION_TYPES.includes(type)) {
    return { success: false, error: `Unknown notification type: ${type}` };
  }

  const { error } = await supabase
    .from('notification_outbox')
    .upsert(
      {
        recipient_id: userId,
        notification_type: type,
        data,
        dedupe_key: dedupeKey,
      },
      { onConflict: 'recipient_id,dedupe_key', ignoreDuplicates: true },
    );
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function processNotificationOutbox(
  limit = 100,
): Promise<ServiceResponse<{ processed: number; failed: number }>> {
  const { data: pending, error } = await supabase
    .from('notification_outbox')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 500)));

  if (error) return { success: false, error: error.message };

  let processed = 0;
  let failed = 0;
  for (const row of pending ?? []) {
    const preferences = await getPreferences(row.recipient_id);
    if (!preferences.success || !preferences.data) {
      failed++;
      const update = await supabase
        .from('notification_outbox')
        .update({
          attempt_count: row.attempt_count + 1,
          last_error: preferences.error ?? 'Notification preferences unavailable',
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'pending');
      if (update.error) console.error('[NotificationOutbox] Failed to persist retry:', update.error.message);
      continue;
    }

    const notificationType = row.notification_type as NotificationType;
    const enabled = preferences.data.notification_types[notificationType] !== false;
    if (!enabled) {
      const suppressed = await supabase
        .from('notification_outbox')
        .update({ status: 'suppressed', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'pending');
      if (suppressed.error) {
        failed++;
        console.error('[NotificationOutbox] Failed to persist suppression:', suppressed.error.message);
      } else {
        processed++;
      }
      continue;
    }

    const result = await createNotification(
      row.recipient_id,
      notificationType,
      row.data as Record<string, unknown>,
      row.dedupe_key,
    );
    if (!result.success) {
      failed++;
      const update = await supabase
        .from('notification_outbox')
        .update({
          attempt_count: row.attempt_count + 1,
          last_error: result.error,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .eq('status', 'pending');
      if (update.error) console.error('[NotificationOutbox] Failed to persist retry:', update.error.message);
      continue;
    }

    const delivered = await supabase
      .from('notification_outbox')
      .update({ status: 'sent', last_error: null, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending');
    if (delivered.error) {
      failed++;
      console.error('[NotificationOutbox] Failed to mark notification sent:', delivered.error.message);
    } else {
      processed++;
    }
  }

  return failed > 0
    ? { success: false, error: `${failed} outbox notification(s) will be retried`, data: { processed, failed } }
    : { success: true, data: { processed, failed } };
}

export async function getNotifications(userId: string, page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Notification>>> {
  const query = supabase
    .from('notifications')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, Math.min(Math.max(1, pageSize), 100));
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

/**
 * Cursor-based paginated notification list.
 *
 * Sort key: (created_at DESC, id DESC) — stable even under concurrent inserts.
 * We fetch limit+1 rows so we can detect whether a next page exists.
 *
 * @param userId - The authenticated user's ID
 * @param cursor - Opaque cursor returned from a previous call (omit for first page)
 * @param limit  - Page size, default 20, max 100
 */
export async function getNotificationsCursor(
  userId: string,
  cursor?: string | null,
  limit = 20,
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

  return { success: true, data: page };
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
  return { success: true };
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
  return { success: true };
}

export async function deleteAllNotifications(userId: string): Promise<ServiceResponse<number>> {
  const { data, error } = await supabase
    .from('notifications')
    .delete()
    .eq('user_id', userId)
    .select('id');

  if (error) return { success: false, error: error.message };
  return { success: true, data: data?.length ?? 0 };
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
  data: Record<string, unknown>
): Promise<ServiceResponse<Notification>> {
  const result = await createNotification(userId, type, data);
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
  data: Record<string, unknown>
): Promise<ServiceResponse<void>> {
  const inAppResult = await createNotification(userId, type, data);
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

  let notified = 0;

  for (const followerId of followerIds) {
    try {
      // Respect per-user in-app notification preferences
      const send = await shouldSendInApp(followerId, 'new_property');
      if (!send) continue;

      const result = await createNotification(followerId, 'new_property', payload);
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
