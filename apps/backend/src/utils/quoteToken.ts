/**
 * Signed price-quote tokens (#754).
 *
 * A quote token binds an authoritative total to the exact inputs it was computed
 * for (listing, dates, listing version) and expires. Booking creation verifies the
 * token before reserving dates, so the amount a tenant confirms cannot drift from
 * the amount the server charges.
 *
 * Tokens are only issued when QUOTE_SIGNING_SECRET is configured. Without it,
 * booking still re-prices server-side; the token is an additional binding.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export interface QuoteTokenClaims {
  /** Property ID the quote was computed for. */
  pid: string;
  /** Normalised check-in instant (ISO 8601). */
  ci: string;
  /** Normalised check-out instant (ISO 8601). */
  co: string;
  /** Total the tenant is charged, in dollars, rounded to cents. */
  tot: number;
  /** Listing version: the property's updated_at when the quote was computed. */
  ver: string;
  /** Expiry instant (ISO 8601). */
  exp: string;
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Produce a `<payload>.<signature>` token, or null when no signing secret is set.
 */
export function signQuoteToken(
  claims: QuoteTokenClaims,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): string | null {
  if (!secret) return null;
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify a token's signature and decode its claims.
 *
 * @returns The claims when the signature is valid, otherwise null. Expiry and
 *          input matching are the caller's responsibility.
 */
export function verifyQuoteToken(
  token: string,
  secret: string = process.env.QUOTE_SIGNING_SECRET ?? '',
): QuoteTokenClaims | null {
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, secret), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QuoteTokenClaims;
  } catch {
    return null;
  }
}
