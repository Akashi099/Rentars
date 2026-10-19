import { Router } from 'express';
import { getCalendarFeed } from '@/controllers/booking.controller.js';

const router = Router();

// Public endpoint — authenticated via HMAC token embedded in the URL.
// GET /api/v1/calendar/feed/:userId/:token.ics
router.get('/feed/:userId/:token', getCalendarFeed);

export default router;
