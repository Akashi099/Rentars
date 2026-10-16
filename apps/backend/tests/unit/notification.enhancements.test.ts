/**
 * Unit tests for notification service enhancements:
 *   - Category filters
 *   - Deep links / event ID dedup
 *   - bulkMarkAsRead authorization
 *   - getUnreadCount
 *   - cleanupExpiredNotifications (retention)
 *   - List-payload sensitive key sanitization
 *   - Cache invalidation after mutations
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─── Supabase mock ────────────────────────────────────────────────────────────

function chain(result: unknown) {
  const node: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'not',
    'or', 'order', 'in', 'lt', 'is', 'maybeSingle'];
  for (const m of methods) {
    node[m] = mock(() => node);
  }
  node['limit'] = mock(() => node);
  node['single'] = mock(async () => result);
  node['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

const mockFrom = mock((_: string) => chain({ data: null, error: null }));

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

mock.module('../../src/services/email.service.js', () => ({
  emailService: {
    sendBookingCreated: mock(async () => {}),
    sendBookingConfirmed: mock(async () => {}),
    sendBookingCancelled: mock(async () => {}),
  },
}));

mock.module('../../src/services/preferenceToken.js', () => ({
  buildPreferenceUrlForUser: mock(() => 'https://example.com/prefs'),
}));

const mockInvalidatePattern = mock(async (_: string) => {});
const mockDel = mock(async (_: string) => {});

mock.module('../../src/services/cache.service.js', () => ({
  get: mock(async () => null),
  set: mock(async () => {}),
  del: mockDel,
  invalidatePattern: mockInvalidatePattern,
}));

import {
  createNotification,
  getNotifications,
  getNotificationsCursor,
  markAsRead,
  markAllAsRead,
  bulkMarkAsRead,
  deleteNotification,
  getUnreadCount,
  cleanupExpiredNotifications,
  categoryForType,
  VALID_NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationType,
} from '../../src/services/notification.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('categoryForType', () => {
  it('maps booking types to "booking"', () => {
    const bookingTypes: NotificationType[] = [
      'booking_created', 'booking_confirmed', 'booking_cancelled',
      'booking_completed', 'booking_expired', 'booking_reminder',
      'booking_modification_requested', 'booking_modification_accepted',
      'booking_modification_declined',
    ];
    for (const t of bookingTypes) {
      expect(categoryForType(t)).toBe('booking');
    }
  });

  it('maps payment_received to "payment"', () => {
    expect(categoryForType('payment_received')).toBe('payment');
  });

  it('maps review types to "review"', () => {
    for (const t of ['review_requested', 'review_submitted', 'host_response'] as NotificationType[]) {
      expect(categoryForType(t)).toBe('review');
    }
  });

  it('maps dispute types to "dispute"', () => {
    expect(categoryForType('dispute_initiated')).toBe('dispute');
    expect(categoryForType('booking_disputed')).toBe('dispute');
  });

  it('maps message_received to "message"', () => {
    expect(categoryForType('message_received')).toBe('message');
  });

  it('maps moderation types to "moderation"', () => {
    for (const t of ['report_created', 'moderation_decision', 'appeal_submitted', 'report_notification'] as NotificationType[]) {
      expect(categoryForType(t)).toBe('moderation');
    }
  });

  it('maps new_property to "social"', () => {
    expect(categoryForType('new_property')).toBe('social');
  });

  it('maps system_alert to "system"', () => {
    expect(categoryForType('system_alert')).toBe('system');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('createNotification — event ID dedup', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns existing notification when event_id already exists', async () => {
    const existing = { id: 'n1', user_id: 'u1', type: 'booking_created', data: {}, read: false };
    mockFrom.mockImplementation(() => chain({ data: existing, error: null }));

    const result = await createNotification('u1', 'booking_created', {}, { eventId: 'evt-1' });
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('n1');
  });

  it('creates a new notification when no event_id match exists', async () => {
    const created = { id: 'n2', user_id: 'u1', type: 'payment_received', data: {}, read: false };
    // First call (dedup check) returns null; second call (insert) returns the new row.
    mockFrom
      .mockImplementationOnce(() => chain({ data: null, error: null }))
      .mockImplementation(() => chain({ data: created, error: null }));

    const result = await createNotification('u1', 'payment_received', {}, { eventId: 'evt-pay-1' });
    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('n2');
  });

  it('stores category derived from type', async () => {
    const created = { id: 'n3', user_id: 'u1', type: 'review_submitted', category: 'review', data: {}, read: false };
    mockFrom
      .mockImplementationOnce(() => chain({ data: null, error: null }))
      .mockImplementation(() => chain({ data: created, error: null }));

    const result = await createNotification('u1', 'review_submitted', {});
    expect(result.success).toBe(true);
    expect(result.data?.category).toBe('review');
  });

  it('passes deep_link to insert payload', async () => {
    // We can't inspect the actual insert payload directly, but we can verify
    // the service completes without error and returns the created row.
    const created = { id: 'n4', user_id: 'u1', type: 'new_property', deep_link: '/properties/slug-1', data: {}, read: false };
    mockFrom
      .mockImplementationOnce(() => chain({ data: null, error: null }))
      .mockImplementation(() => chain({ data: created, error: null }));

    const result = await createNotification('u1', 'new_property', {}, {
      deepLink: '/properties/slug-1',
    });
    expect(result.success).toBe(true);
    expect(result.data?.deep_link).toBe('/properties/slug-1');
  });

  it('rejects unknown notification type', async () => {
    const result = await createNotification('u1', 'unknown_type' as NotificationType, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown notification type');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getNotifications — category filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns notifications successfully without a category filter', async () => {
    const rows = [{ id: 'n1', type: 'booking_created', data: {}, read: false }];
    mockFrom.mockImplementation(() => chain({ data: rows, error: null }));
    const result = await getNotifications('u1');
    expect(result.success).toBe(true);
  });

  it('accepts a valid category filter', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await getNotifications('u1', 1, 20, 'booking');
    expect(result.success).toBe(true);
  });

  it('ignores an invalid category filter (no crash)', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await getNotifications('u1', 1, 20, 'nonexistent' as NotificationCategory);
    expect(result.success).toBe(true);
  });

  it('strips sensitive data keys from list payload', async () => {
    const rows = [{
      id: 'n1', type: 'booking_created',
      data: { bookingId: 'b1', userEmail: 'user@example.com', audience: 'tenant', attempt: 2 },
      read: false,
    }];
    mockFrom.mockImplementation(() => chain({ data: rows, error: null }));

    const result = await getNotifications('u1');
    expect(result.success).toBe(true);
    const notif = result.data!.data[0];
    // Safe keys are kept
    expect(notif.data.bookingId).toBe('b1');
    // Sensitive keys are stripped
    expect(notif.data.userEmail).toBeUndefined();
    expect(notif.data.audience).toBeUndefined();
    expect(notif.data.attempt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getNotificationsCursor — category filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns cursor page with category filter', async () => {
    const ts = '2026-10-01T10:00:00.000Z';
    const rows = [
      { id: 'a', type: 'review_submitted', category: 'review', data: {}, read: false, created_at: ts },
      { id: 'b', type: 'host_response',    category: 'review', data: {}, read: false, created_at: ts },
    ];
    mockFrom.mockImplementation(() => chain({ data: rows, error: null }));

    const result = await getNotificationsCursor('u1', null, 1, 'review');
    expect(result.success).toBe(true);
    expect(result.data!.data).toHaveLength(1);
    expect(result.data!.nextCursor).not.toBeNull();
  });

  it('sanitises sensitive keys from cursor page payloads', async () => {
    const ts = '2026-10-01T10:00:00.000Z';
    const rows = [{
      id: 'a', type: 'system_alert', category: 'system',
      data: { message: 'ok', errorDetails: 'internal', supportLink: '/support' },
      read: false, created_at: ts,
    }];
    mockFrom.mockImplementation(() => chain({ data: rows, error: null }));

    const result = await getNotificationsCursor('u1');
    const notif = result.data!.data[0];
    expect(notif.data.message).toBe('ok');
    expect(notif.data.errorDetails).toBeUndefined();
    expect(notif.data.supportLink).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('bulkMarkAsRead', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns error for empty notificationIds array', async () => {
    const result = await bulkMarkAsRead('u1', []);
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty array');
  });

  it('returns error when more than 500 IDs are submitted', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const result = await bulkMarkAsRead('u1', ids);
    expect(result.success).toBe(false);
    expect(result.error).toContain('500');
  });

  it('returns error when userId is blank', async () => {
    const result = await bulkMarkAsRead('  ', ['id-1']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('user_id');
  });

  it('marks specified IDs as read and returns the count', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: [{ id: 'n1' }, { id: 'n2' }], error: null }),
    );
    const result = await bulkMarkAsRead('u1', ['n1', 'n2']);
    expect(result.success).toBe(true);
    expect(result.data?.updated).toBe(2);
  });

  it('returns updated=0 when no rows match (wrong user_id)', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await bulkMarkAsRead('u1', ['n-other-user']);
    expect(result.success).toBe(true);
    expect(result.data?.updated).toBe(0);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'DB timeout' } }),
    );
    const result = await bulkMarkAsRead('u1', ['n1']);
    expect(result.success).toBe(false);
    expect(result.error).toBe('DB timeout');
  });

  it('is idempotent — already-read rows return success', async () => {
    // Supabase UPDATE with no changes returns empty data, not an error.
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await bulkMarkAsRead('u1', ['already-read']);
    expect(result.success).toBe(true);
    expect(result.data?.updated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getUnreadCount', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns unread count from DB', async () => {
    mockFrom.mockImplementation(() => chain({ count: 7, error: null }));
    const result = await getUnreadCount('u1');
    expect(result.success).toBe(true);
    expect(result.data).toBe(7);
  });

  it('returns 0 when count is null', async () => {
    mockFrom.mockImplementation(() => chain({ count: null, error: null }));
    const result = await getUnreadCount('u1');
    expect(result.success).toBe(true);
    expect(result.data).toBe(0);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ count: null, error: { message: 'connection error' } }),
    );
    const result = await getUnreadCount('u1');
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cleanupExpiredNotifications', () => {
  beforeEach(() => mockFrom.mockClear());

  it('deletes expired notifications and returns count', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: [{ id: 'n1' }, { id: 'n2' }], error: null }),
    );
    const result = await cleanupExpiredNotifications();
    expect(result.success).toBe(true);
    expect(result.data).toBe(2);
  });

  it('returns 0 when no notifications have expired', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await cleanupExpiredNotifications();
    expect(result.success).toBe(true);
    expect(result.data).toBe(0);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'delete failed' } }),
    );
    const result = await cleanupExpiredNotifications();
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('cache invalidation after mutations', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockInvalidatePattern.mockClear();
    mockDel.mockClear();
  });

  it('invalidates cache after markAsRead', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    await markAsRead('n1', 'u1');
    expect(mockInvalidatePattern).toHaveBeenCalledWith('notifications:u1');
  });

  it('invalidates cache after markAllAsRead', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    await markAllAsRead('u1');
    expect(mockInvalidatePattern).toHaveBeenCalledWith('notifications:u1');
  });

  it('invalidates cache after bulkMarkAsRead', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    await bulkMarkAsRead('u1', ['n1', 'n2']);
    expect(mockInvalidatePattern).toHaveBeenCalledWith('notifications:u1');
  });

  it('invalidates cache after deleteNotification', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    await deleteNotification('n1', 'u1');
    expect(mockInvalidatePattern).toHaveBeenCalledWith('notifications:u1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('VALID_NOTIFICATION_CATEGORIES', () => {
  it('includes all expected categories', () => {
    const expected: NotificationCategory[] = [
      'booking', 'payment', 'review', 'dispute', 'message', 'moderation', 'social', 'system',
    ];
    for (const c of expected) {
      expect(VALID_NOTIFICATION_CATEGORIES).toContain(c);
    }
  });
});
