import { z } from 'zod';

/** Bulk mark-as-read: array of notification UUIDs. */
export const bulkMarkAsReadSchema = z.object({
  notificationIds: z
    .array(z.string().uuid('Each notificationId must be a valid UUID'))
    .min(1, 'notificationIds must contain at least one UUID')
    .max(500, 'Cannot mark more than 500 notifications at once'),
});
