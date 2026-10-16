/**
 * Message service — rate-limited, property-scoped inquiries between a
 * prospective tenant and a host. No private contact info is ever exposed;
 * participants only see each other's user id.
 *
 * Abuse prevention (added alongside core messaging):
 *  - Block check: neither party can message if a block exists in either direction.
 *  - Per-conversation daily limit (MESSAGE_DAILY_LIMIT): throttles bursts
 *    without affecting legitimate booking communication.
 *  - Link safety: messages containing unsafe protocol links are rejected;
 *    shortener links are flagged and auto-submitted as abuse reports for review.
 *  - Content length: body is capped at 2 000 chars after sanitisation.
 */

import { supabase } from '../config/supabase.js';
import { sanitizeResponse } from '../utils/sanitize.js';
import { checkAndSanitizeLinks } from '../utils/linkSafety.js';
import { createNotification, shouldSendInApp } from './notification.service.js';
import { isBlocked } from './blockList.service.js';
import { createAbuseReport } from './blockList.service.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum message body length (characters, after sanitisation). */
const MAX_BODY_LENGTH = 2_000;

/**
 * Maximum messages exchanged in a single (property, conversation) pair per day.
 * Hosts and tenants share this budget so each side effectively gets ~15 sends.
 */
const MESSAGE_DAILY_LIMIT = 30;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  property_id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

// ─── Daily limit helpers ──────────────────────────────────────────────────────

/**
 * Returns canonical (participant_a, participant_b) where participant_a < participant_b.
 * Ensures the message_daily_counts PK is always the same regardless of send direction.
 */
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Check whether the daily message limit for this conversation has been reached.
 * Returns true if the sender may proceed.
 */
async function checkDailyLimit(
  propertyId: string,
  senderId: string,
  recipientId: string,
): Promise<{ allowed: boolean; current: number }> {
  const [pa, pb] = canonicalPair(senderId, recipientId);
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  const { data } = await supabase
    .from('message_daily_counts')
    .select('message_count')
    .eq('property_id', propertyId)
    .eq('participant_a', pa)
    .eq('participant_b', pb)
    .eq('day', today)
    .maybeSingle();

  const current = (data as { message_count: number } | null)?.message_count ?? 0;
  return { allowed: current < MESSAGE_DAILY_LIMIT, current };
}

/**
 * Atomically increment the daily counter for this conversation.
 * Uses upsert so the first message of the day creates the row.
 */
async function incrementDailyCount(
  propertyId: string,
  senderId: string,
  recipientId: string,
): Promise<void> {
  const [pa, pb] = canonicalPair(senderId, recipientId);
  const today = new Date().toISOString().slice(0, 10);

  // Read-then-write is acceptable here: the daily limit is a soft guard,
  // not a financial boundary, so a rare race condition that lets one extra
  // message through is acceptable.
  const { data: existing } = await supabase
    .from('message_daily_counts')
    .select('message_count')
    .eq('property_id', propertyId)
    .eq('participant_a', pa)
    .eq('participant_b', pb)
    .eq('day', today)
    .maybeSingle();

  const current = (existing as { message_count: number } | null)?.message_count ?? 0;

  await supabase.from('message_daily_counts').upsert(
    {
      property_id: propertyId,
      participant_a: pa,
      participant_b: pb,
      day: today,
      message_count: current + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'property_id,participant_a,participant_b,day' },
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a message about a property. If `recipientId` is omitted, the message
 * is addressed to the property's host (owner) — this is how a tenant starts
 * an inquiry without ever needing to know the host's user id up front.
 *
 * Abuse prevention flow:
 *  1. Block check (bidirectional).
 *  2. Daily per-conversation limit.
 *  3. Link safety: reject unsafe protocol links; flag shortener links.
 *  4. Sanitise body (HTML-strip + length cap).
 */
export async function sendMessage(
  senderId: string,
  propertyId: string,
  body: string,
  recipientId?: string,
): Promise<ServiceResponse<Message>> {
  // ── Resolve property & recipient ─────────────────────────────────────────────
  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', propertyId)
    .single();

  if (propertyError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const resolvedRecipientId = recipientId || (property as { owner_id: string }).owner_id;

  if (resolvedRecipientId === senderId) {
    return { success: false, error: 'You cannot message yourself' };
  }

  // ── 1. Block check ────────────────────────────────────────────────────────────
  const blocked = await isBlocked(senderId, resolvedRecipientId);
  if (blocked) {
    return {
      success: false,
      error: 'You cannot send messages to this user',
    };
  }

  // ── 2. Daily limit ────────────────────────────────────────────────────────────
  const { allowed, current } = await checkDailyLimit(propertyId, senderId, resolvedRecipientId);
  if (!allowed) {
    return {
      success: false,
      error: `Daily message limit of ${MESSAGE_DAILY_LIMIT} reached for this conversation. Please try again tomorrow.`,
    };
  }

  // ── 3. Link safety ────────────────────────────────────────────────────────────
  const linkCheck = checkAndSanitizeLinks(body);

  if (linkCheck.hasUnsafe) {
    return {
      success: false,
      error: 'Your message contains unsafe links and cannot be sent.',
    };
  }

  // ── 4. Sanitise body ──────────────────────────────────────────────────────────
  const cleanBody = sanitizeResponse(linkCheck.sanitizedText, MAX_BODY_LENGTH);
  if (!cleanBody) {
    return { success: false, error: 'Message body is required' };
  }

  // ── 5. Persist ────────────────────────────────────────────────────────────────
  const { data, error } = await supabase
    .from('messages')
    .insert({
      property_id: propertyId,
      sender_id: senderId,
      recipient_id: resolvedRecipientId,
      body: cleanBody,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  const message = data as Message;

  // ── 6. Increment daily counter ────────────────────────────────────────────────
  await incrementDailyCount(propertyId, senderId, resolvedRecipientId).catch((err) =>
    console.error('[sendMessage] Failed to increment daily count:', err),
  );

  // ── 7. Auto-flag shortener links for moderation review ────────────────────────
  if (linkCheck.hasShortener) {
    createAbuseReport(
      senderId,
      'message',
      message.id,
      'unsafe_link',
      `Message contains URL shortener links: ${linkCheck.classifications
        .filter((c) => c.verdict === 'shortener')
        .map((c) => c.url)
        .join(', ')
        .slice(0, 500)}`,
    ).catch((err) =>
      console.error('[sendMessage] Failed to auto-flag shortener link:', err),
    );
  }

  // ── 8. Notify recipient ───────────────────────────────────────────────────────
  try {
    const send = await shouldSendInApp(resolvedRecipientId, 'message_received');
    if (send) {
      await createNotification(resolvedRecipientId, 'message_received', {
        messageId: message.id,
        propertyId,
        senderId,
      });
    }
  } catch (err) {
    console.error(`[sendMessage] Failed to notify recipient ${resolvedRecipientId}:`, err);
  }

  return { success: true, data: message };
}

/**
 * List the conversation between the caller and another user, scoped to a
 * single property. Both participants may call this for their own thread.
 */
export async function getConversation(
  userId: string,
  otherUserId: string,
  propertyId: string,
): Promise<ServiceResponse<Message[]>> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('property_id', propertyId)
    .or(
      `and(sender_id.eq.${userId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${userId})`,
    )
    .order('created_at', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as Message[] };
}

/**
 * Mark a message read. Only the recipient may mark their own inbound message.
 */
export async function markMessageRead(
  messageId: string,
  userId: string,
): Promise<ServiceResponse<Message>> {
  const { data, error } = await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('id', messageId)
    .eq('recipient_id', userId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Message not found' };

  return { success: true, data: data as Message };
}
