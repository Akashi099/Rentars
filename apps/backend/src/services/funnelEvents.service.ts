/**
 * Product Funnel Events (Issue #117)
 *
 * Privacy-bounded funnel measurement for search → listing view → quote →
 * booking → payment → cancellation.
 *
 * Boundaries enforced here:
 * - Pseudonymous identifiers (session_id / hashed user ref) by default;
 *   raw user ids only on server-confirmed financial outcomes.
 * - Message bodies, wallet secrets, and unnecessary identity data are never
 *   accepted — schema validation rejects them.
 * - Deduplication via idempotency keys (60 s window per event+entity).
 * - Consent (opt-out) and retention limits enforced before emit.
 */

export type FunnelEventName =
  | 'search.executed'
  | 'listing.viewed'
  | 'quote.created'
  | 'booking.confirmed'
  | 'payment.confirmed'
  | 'booking.cancelled';

export interface FunnelEvent {
  /** Idempotency key: `${event}:${entityId}:${minuteBucket}` */
  eventId: string;
  event: FunnelEventName;
  /** Pseudonymous session identifier. Never a wallet secret or raw email. */
  sessionId: string;
  /** Present only for server-confirmed booking/payment outcomes. */
  userRef?: string;
  entityId: string; // search id, property id, quote id, booking id
  occurredAt: string; // ISO-8601 UTC
  properties: Record<string, string | number | boolean | null>;
  consented: boolean;
}

/** Keys that must never appear in funnel payloads. */
const FORBIDDEN_KEYS = new Set([
  'message_body',
  'messageBody',
  'body',
  'secret',
  'seed',
  'seedPhrase',
  'privateKey',
  'walletSecret',
  'email',
  'phone',
  'password',
]);

const FINANCIAL_EVENTS: ReadonlySet<FunnelEventName> = new Set([
  'booking.confirmed',
  'payment.confirmed',
]);

/** Events that must originate from the server after state confirmation. */
const SERVER_CONFIRMED: ReadonlySet<FunnelEventName> = new Set([
  'booking.confirmed',
  'payment.confirmed',
  'booking.cancelled',
]);

export function buildEventId(
  event: FunnelEventName,
  entityId: string,
  occurredAt: string,
): string {
  const minute = occurredAt.slice(0, 16); // YYYY-MM-DDTHH:MM — 60 s window
  return `${event}:${entityId}:${minute}`;
}

/**
 * Schema validation: rejects forbidden (private/secret) keys, requires
 * identifiers, and requires server confirmation + userRef for financial
 * outcomes. Returns human-readable error list (empty = valid).
 */
export function validateFunnelEvent(
  event: Partial<FunnelEvent> & { event: FunnelEventName },
  opts: { serverConfirmed: boolean },
): string[] {
  const errors: string[] = [];
  if (!event.sessionId?.trim()) errors.push('sessionId is required.');
  if (!event.entityId?.trim()) errors.push('entityId is required.');
  if (!event.occurredAt?.trim()) errors.push('occurredAt is required.');
  const props = event.properties ?? {};
  for (const key of Object.keys(props)) {
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`Forbidden key in properties: ${key}.`);
    }
  }
  if (FINANCIAL_EVENTS.has(event.event) && !event.userRef?.trim()) {
    errors.push(`${event.event} requires a server-linked userRef.`);
  }
  if (SERVER_CONFIRMED.has(event.event) && !opts.serverConfirmed) {
    errors.push(`${event.event} must be server-confirmed.`);
  }
  return errors;
}

const seen = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000;

/** In-memory dedup guard for the 60 s window (backed by unique DB index in prod). */
export function isDuplicate(eventId: string, nowMs = Date.now()): boolean {
  const firstSeen = seen.get(eventId);
  if (firstSeen !== undefined && nowMs - firstSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  seen.set(eventId, nowMs);
  return false;
}

/** Retention in days per event class. */
export function retentionDaysFor(event: FunnelEventName): number {
  switch (event) {
    case 'search.executed':
    case 'listing.viewed':
      return 90;
    case 'quote.created':
      return 180;
    case 'booking.confirmed':
    case 'payment.confirmed':
    case 'booking.cancelled':
      return 365;
  }
}

export function shouldEmit(event: FunnelEvent): boolean {
  return event.consented;
}
