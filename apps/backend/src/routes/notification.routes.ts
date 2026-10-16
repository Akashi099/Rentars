import { Router } from 'express';
import {
  clearAllNotifications,
  getNotificationPreferences,
  getPreferencesByToken,
  listNotifications,
  listNotificationsCursorHandler,
  unreadCountHandler,
  bulkReadNotifications,
  readAllNotifications,
  readNotification,
  registerPushSubscription,
  removeNotification,
  unregisterPushSubscription,
  updateNotificationPreferences,
  updatePreferencesByToken,
} from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { validatePagination } from '../validators/pagination.validator.js';
import { bulkMarkAsReadSchema } from '../validators/notification.validator.js';
import { validateBody } from '../validators/booking.validator.js';

const router = Router();

// GET /api/v1/notifications  (supports ?category= filter)
router.get('/', authenticate, validatePagination, listNotifications);

// GET /api/v1/notifications/cursor  (cursor-based pagination with ?category= filter)
router.get('/cursor', authenticate, listNotificationsCursorHandler);

// GET /api/v1/notifications/unread-count
router.get('/unread-count', authenticate, unreadCountHandler);

// POST /api/v1/notifications/bulk-read  (mark specific IDs as read)
router.post('/bulk-read', authenticate, validateBody(bulkMarkAsReadSchema), bulkReadNotifications);

// PATCH /api/v1/notifications/read-all
router.patch('/read-all', authenticate, readAllNotifications);

// DELETE /api/v1/notifications/clear-all
router.delete('/clear-all', authenticate, clearAllNotifications);

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', authenticate, readNotification);

// DELETE /api/v1/notifications/:id
router.delete('/:id', authenticate, removeNotification);

// GET /api/v1/notifications/preferences  (authenticated)
router.get('/preferences', authenticate, getNotificationPreferences);

// PATCH /api/v1/notifications/preferences  (authenticated)
router.patch('/preferences', authenticate, updateNotificationPreferences);

// GET  /api/v1/notifications/manage-preferences?token=...  (token-based, no login)
router.get('/manage-preferences', getPreferencesByToken);

// PATCH /api/v1/notifications/manage-preferences?token=...  (token-based, no login)
router.patch('/manage-preferences', updatePreferencesByToken);

// POST /api/v1/notifications/push/subscribe
router.post('/push/subscribe', authenticate, registerPushSubscription);

// POST /api/v1/notifications/push/unsubscribe
router.post('/push/unsubscribe', authenticate, unregisterPushSubscription);

export default router;
