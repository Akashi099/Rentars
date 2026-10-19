/**
 * Email Webhook Controller
 *
 * Handles inbound delivery status callbacks from the SMTP/ESP provider.
 *
 * Security:
 *  - HMAC-SHA256 signature verified before any processing (EMAIL_WEBHOOK_SECRET)
 *  - Replay protection: event IDs are deduplicated against email_webhook_events
 *  - Idempotent: re-delivering the same event_id is a 200 no-op
 *
 * Supported event types (provider-agnostic normalised form):
 *  - delivery  → markDelivered()
 *  - bounce    → markBounced() + auto-suppress on hard bounce
 *  - complaint → markComplaint() + auto-suppress
 *  - failed    → markFailed()
 *
 * The raw payload is stored in email_webhook_events for audit purposes.
 * Recipient email addresses inside the payload are never logged to stdout.
 */

import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import {
  findByProviderMessageId,
  markDelivered,
  markBounced,
  markComplaint,
  markFailed,
} from '../services/emailDelivery.service.js';

// ─── Signature verification ────────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 webhook signature.
 *
 * We use `timingSafeEqual` to prevent timing-oracle attacks.
 * Expected header: `X-Email-Webhook-Signature: sha256=<hex>`
 */
function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.EMAIL_WEBHOOK_SECRET) {
    // If the secret is not configured, reject all webhooks — never allow
    // unsigned events through even in dev.
    return false;
  }

  if (!signature || !signature.startsWith('sha256=')) return false;

  const expected = createHmac('sha256', env.EMAIL_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  const provided = signature.slice('sha256='.length);

  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

// ─── Replay protection ────────────────────────────────────────────────────────

/**
 * Record an event_id to prevent replay.
 * Returns true if the event is NEW (should be processed).
 * Returns false if it has already been seen (should be skipped — 200 no-op).
 */
async function recordEvent(
  eventId: string,
  eventType: string,
  rawPayload: Record<string, unknown>,
  provider: string,
): Promise<boolean> {
  const { error } = await supabase.from('email_webhook_events').insert({
    event_id: eventId,
    provider,
    event_type: eventType,
    raw_payload: rawPayload,
  });

  // Duplicate key error means we've already processed this event → no-op
  if (error) {
    if (error.code === '23505') return false; // unique_violation
    // For any other error, let it through (fail-open for audit purposes)
  }

  return true;
}

// ─── Normalised event shape ────────────────────────────────────────────────────

interface NormalisedEvent {
  eventId: string;
  eventType: 'delivery' | 'bounce' | 'complaint' | 'failed';
  providerMessageId: string;
  recipientEmail: string;
  /** For bounces: true = soft bounce (temporary), false = hard bounce (permanent) */
  isSoftBounce?: boolean;
  errorCode?: string;
  errorMessage?: string;
  occurredAt?: string;
  provider: string;
}

/**
 * Normalise a raw webhook payload to our internal event shape.
 *
 * This is intentionally provider-agnostic: we look for common field names
 * (messageId / message_id, event / type, recipient / email) so the same
 * handler works for SendGrid, Mailgun, Postmark, and raw nodemailer SMTP DSNs.
 *
 * Returns null if the payload cannot be mapped to a known event type.
 */
function normalisePayload(payload: Record<string, unknown>): NormalisedEvent | null {
  // Provider detection (add more as needed)
  const provider = String(
    payload.provider ??
    (payload.sg_event_id ? 'sendgrid' : payload.MessageID ? 'postmark' : 'unknown'),
  );

  // Event ID — required for replay protection
  const eventId = String(
    payload.event_id ??
    payload.sg_event_id ??
    payload.MessageID ??
    payload.id ??
    '',
  );
  if (!eventId) return null;

  // Provider message ID — used to correlate back to our delivery log
  const providerMessageId = String(
    payload.message_id ??
    payload.MessageID ??
    payload.smtp_id ??
    payload.messageId ??
    '',
  );
  if (!providerMessageId) return null;

  // Recipient (not stored — only used for suppression writes)
  const recipientEmail = String(
    payload.email ??
    payload.recipient ??
    payload.To ??
    '',
  ).toLowerCase().trim();
  if (!recipientEmail) return null;

  // Normalise event type
  const rawType = String(payload.event ?? payload.type ?? payload.RecordType ?? '').toLowerCase();

  let eventType: NormalisedEvent['eventType'];
  let isSoftBounce: boolean | undefined;

  if (['delivery', 'delivered'].includes(rawType)) {
    eventType = 'delivery';
  } else if (['bounce', 'bounced', 'hardbounce', 'softbounce', 'invalid'].includes(rawType)) {
    eventType = 'bounce';
    // Soft bounce if explicitly flagged, or if the raw type says "soft"
    isSoftBounce =
      payload.bounce_type === 'soft' ||
      rawType === 'softbounce' ||
      payload.soft === true;
  } else if (['spam', 'complaint', 'spamreport'].includes(rawType)) {
    eventType = 'complaint';
  } else if (['fail', 'failed', 'deferred', 'dropped'].includes(rawType)) {
    eventType = 'failed';
  } else {
    return null; // unrecognised event type — ignore
  }

  return {
    eventId,
    eventType,
    providerMessageId,
    recipientEmail,
    isSoftBounce,
    errorCode: payload.status ? String(payload.status) : undefined,
    errorMessage: payload.reason ? String(payload.reason) : undefined,
    occurredAt: payload.timestamp
      ? new Date(Number(payload.timestamp) * 1000).toISOString()
      : new Date().toISOString(),
    provider,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/email/webhook
 *
 * Entry point for all inbound provider delivery status events.
 * Requires raw body access — ensure express.raw() is applied before this route.
 */
export async function handleEmailWebhook(req: Request, res: Response): Promise<void> {
  // ── 1. Signature check ──────────────────────────────────────────────────────
  const signature = req.headers['x-email-webhook-signature'] as string | undefined;
  const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));

  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' } });
    return;
  }

  // ── 2. Parse payload ────────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)
      : JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Request body must be valid JSON' } });
    return;
  }

  const event = normalisePayload(payload);
  if (!event) {
    // Unknown event type — acknowledge receipt to stop provider retrying
    res.status(200).json({ status: 'ignored' });
    return;
  }

  // ── 3. Replay protection ────────────────────────────────────────────────────
  const isNew = await recordEvent(event.eventId, event.eventType, payload, event.provider);
  if (!isNew) {
    res.status(200).json({ status: 'duplicate' });
    return;
  }

  // ── 4. Correlate to delivery record ─────────────────────────────────────────
  const lookupResult = await findByProviderMessageId(event.providerMessageId);
  if (!lookupResult.success || !lookupResult.data) {
    // Unknown message ID — still acknowledge to stop retries
    res.status(200).json({ status: 'not_found' });
    return;
  }

  const record = lookupResult.data;

  // ── 5. Update delivery status ────────────────────────────────────────────────
  switch (event.eventType) {
    case 'delivery':
      await markDelivered(record.id, event.occurredAt);
      break;

    case 'bounce':
      await markBounced(
        record.id,
        event.recipientEmail,
        event.isSoftBounce ?? false,
        event.errorCode,
        event.errorMessage,
      );
      break;

    case 'complaint':
      await markComplaint(record.id, event.recipientEmail);
      break;

    case 'failed':
      // Schedule a retry in 30 minutes for transient failures (up to 3 attempts)
      const nextRetry =
        record.attempt_count < 3
          ? new Date(Date.now() + 30 * 60_000).toISOString()
          : null;
      await markFailed(record.id, event.errorCode, event.errorMessage, nextRetry);
      break;
  }

  res.status(200).json({ status: 'processed', eventType: event.eventType });
}
