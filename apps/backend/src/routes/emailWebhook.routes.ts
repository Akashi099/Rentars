/**
 * Email Webhook Routes
 *
 * POST /api/v1/email/webhook
 *
 * Inbound delivery-status callbacks from the SMTP/ESP provider.
 * This route bypasses JSON body parsing so we can read the raw bytes
 * for HMAC-SHA256 signature verification.
 *
 * Security:
 *  - express.raw() captures the raw body for signature comparison.
 *  - No authentication header is required (the signature IS the auth).
 *  - generalRateLimiter guards against webhook-flooding attacks.
 */

import { Router } from 'express';
import express from 'express';
import { handleEmailWebhook } from '../controllers/emailWebhook.controller.js';
import { generalRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Capture raw body bytes before any JSON parsing so the signature can be
// verified against exactly what the provider signed.
router.post(
  '/webhook',
  express.raw({ type: ['application/json', 'text/plain'], limit: '256kb' }),
  generalRateLimiter,
  handleEmailWebhook,
);

export default router;
