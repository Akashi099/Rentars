/**
 * #754 — Authoritative availability and price quotes.
 * Also closes #763 (Issue 038) — occupancy limits enforced at quote and booking boundaries.
 *
 * Verifies:
 *  1. A quote carries an availability flag and a token bound to the stay.
 *  2. Drafts and moderation-hidden listings are not quoted.
 *  3. A booking total must match a fresh server quote to the cent.
 *  4. A quote token is rejected when it is expired, for another stay, or issued before the listing changed.
 *  5. Guest count is bound to the quote token; a token issued for N guests is rejected for M guests.
 *  6. Quoting more guests than the property allows is rejected immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tables, resetTables, supabaseMock } from './support/supabaseChainMock.js';

vi.mock('../config/supabase.js', () => ({ supabase: supabaseMock }));

import { assertQuotedTotal, getPropertyQuote } from '../services/pricing.service.js';
import { signQuoteToken, verifyQuoteToken, type QuoteTokenClaims } from '../utils/quoteToken.js';

const SECRET = 'test-quote-secret';
const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const UPDATED_AT = '2026-10-01T10:00:00.000Z';
const START = '2026-12-01T00:00:00.000Z';
const END = '2026-12-03T00:00:00.000Z';

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPERTY_ID,
    owner_id: '22222222-2222-4222-8222-222222222222',
    status: 'available',
    draft_status: 'active',
    moderation_state: 'visible',
    deleted_at: null,
    base_price_per_night: 100,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

beforeEach(() => {
  resetTables();
  process.env.QUOTE_SIGNING_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.QUOTE_SIGNING_SECRET;
});

describe('quote tokens', () => {
  const claims: QuoteTokenClaims = {
    pid: PROPERTY_ID,
    ci: START,
    co: END,
    tot: 215.25,
    ver: UPDATED_AT,
    exp: '2026-12-01T00:15:00.000Z',
  };

  it('round-trips claims when the signature is intact', () => {
    const token = signQuoteToken(claims, SECRET);
    expect(token).not.toBeNull();
    expect(verifyQuoteToken(token as string, SECRET)).toEqual(claims);
  });

  it('rejects a token whose payload was altered', () => {
    const token = signQuoteToken(claims, SECRET) as string;
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, tot: 1 })).toString('base64url');
    expect(verifyQuoteToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signQuoteToken(claims, 'another-secret') as string;
    expect(verifyQuoteToken(token, SECRET)).toBeNull();
  });

  it('issues no token when signing is not configured', () => {
    expect(signQuoteToken(claims, '')).toBeNull();
    expect(verifyQuoteToken('anything.at-all', '')).toBeNull();
  });
});

describe('getPropertyQuote', () => {
  it('returns an availability flag and a token bound to the stay', async () => {
    tables.properties = [listing()];

    const result = await getPropertyQuote(PROPERTY_ID, START, END);

    expect(result.success).toBe(true);
    expect(result.data?.available).toBe(true);
    expect(result.data?.quote_token).toBeTruthy();
    const claims = verifyQuoteToken(result.data?.quote_token as string, SECRET);
    expect(claims?.pid).toBe(PROPERTY_ID);
    expect(claims?.tot).toBe(result.data?.total);
  });

  it('does not quote drafts or hidden listings', async () => {
    tables.properties = [listing({ moderation_state: 'hidden' })];

    const result = await getPropertyQuote(PROPERTY_ID, START, END);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });
});

describe('assertQuotedTotal', () => {
  async function currentTotal(): Promise<number> {
    const quoted = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: 0 });
    return (quoted.details as { quote: { total: number } }).quote.total;
  }

  it('accepts a total that matches the server quote to the cent', async () => {
    tables.properties = [listing()];
    const total = await currentTotal();

    const result = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: total });

    expect(result.success).toBe(true);
    expect(result.data?.total).toBe(total);
  });

  it('rejects a total that differs from the server quote', async () => {
    tables.properties = [listing()];
    const total = await currentTotal();

    const result = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: total - 10 });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PRICE_CHANGED');
    expect(result.conflict).toBe(true);
  });

  it('rejects an expired quote token', async () => {
    tables.properties = [listing()];
    const total = await currentTotal();
    const token = signQuoteToken(
      { pid: PROPERTY_ID, ci: START, co: END, tot: total, ver: UPDATED_AT, exp: '2026-11-30T00:00:00.000Z' },
      SECRET,
    ) as string;

    const result = await assertQuotedTotal({
      propertyId: PROPERTY_ID,
      checkIn: START,
      checkOut: END,
      clientTotal: total,
      quoteToken: token,
      now: Date.parse('2026-12-01T00:00:00.000Z'),
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('QUOTE_EXPIRED');
  });

  it('rejects a token issued for a different stay', async () => {
    tables.properties = [listing()];
    const total = await currentTotal();
    const token = signQuoteToken(
      { pid: PROPERTY_ID, ci: '2026-12-10T00:00:00.000Z', co: '2026-12-12T00:00:00.000Z', tot: total, ver: UPDATED_AT, exp: '2099-01-01T00:00:00.000Z' },
      SECRET,
    ) as string;

    const result = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: total, quoteToken: token });

    expect(result.success).toBe(false);
    expect(result.code).toBe('QUOTE_MISMATCH');
  });

  it('rejects a token issued before the listing last changed', async () => {
    tables.properties = [listing()];
    const total = await currentTotal();
    const token = signQuoteToken(
      { pid: PROPERTY_ID, ci: START, co: END, tot: total, ver: '2026-09-01T00:00:00.000Z', exp: '2099-01-01T00:00:00.000Z' },
      SECRET,
    ) as string;

    const result = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: total, quoteToken: token });

    expect(result.success).toBe(false);
    expect(result.code).toBe('PRICE_CHANGED');
  });

  it('reports a hidden listing as not found rather than pricing it', async () => {
    tables.properties = [listing({ moderation_state: 'hidden' })];

    const result = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: 200 });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });
});

// ─── Guest count in quote tokens (#763) ──────────────────────────────────────

describe('getPropertyQuote — occupancy enforcement', () => {
  it('embeds gc in the token when guestCount is supplied', async () => {
    tables.properties = [listing({ max_guests: 4 })];

    const result = await getPropertyQuote(PROPERTY_ID, START, END, 2);

    expect(result.success).toBe(true);
    const claims = verifyQuoteToken(result.data?.quote_token as string, SECRET);
    expect(claims?.gc).toBe(2);
  });

  it('omits gc from the token when guestCount is not supplied', async () => {
    tables.properties = [listing({ max_guests: 4 })];

    const result = await getPropertyQuote(PROPERTY_ID, START, END);

    expect(result.success).toBe(true);
    const claims = verifyQuoteToken(result.data?.quote_token as string, SECRET);
    expect(claims?.gc).toBeUndefined();
  });

  it('rejects a quote when guest count exceeds max_guests', async () => {
    tables.properties = [listing({ max_guests: 2 })];

    const result = await getPropertyQuote(PROPERTY_ID, START, END, 5);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.error).toMatch(/capacity/i);
  });

  it('allows a quote when guest count exactly equals max_guests', async () => {
    tables.properties = [listing({ max_guests: 3 })];

    const result = await getPropertyQuote(PROPERTY_ID, START, END, 3);

    expect(result.success).toBe(true);
    const claims = verifyQuoteToken(result.data?.quote_token as string, SECRET);
    expect(claims?.gc).toBe(3);
  });
});

describe('assertQuotedTotal — guest count token binding', () => {
  async function quotedTotal(guests?: number): Promise<number> {
    const q = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: 0, guestCount: guests });
    return (q.details as { quote: { total: number } })?.quote?.total ?? (q.data?.total ?? 0);
  }

  it('rejects a token issued for a different guest count', async () => {
    tables.properties = [listing({ max_guests: 6 })];
    const total = await (async () => {
      const r = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: 0 });
      return (r.details as { quote: { total: number } })?.quote?.total ?? r.data?.total ?? 0;
    })();

    const token = signQuoteToken(
      { pid: PROPERTY_ID, ci: START, co: END, tot: total, ver: UPDATED_AT, exp: '2099-01-01T00:00:00.000Z', gc: 2 },
      SECRET,
    ) as string;

    tables.properties = [listing({ max_guests: 6 })];
    const result = await assertQuotedTotal({
      propertyId: PROPERTY_ID,
      checkIn: START,
      checkOut: END,
      clientTotal: total,
      quoteToken: token,
      guestCount: 4, // different from token's gc: 2
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('QUOTE_MISMATCH');
  });

  it('accepts a token when guest count matches', async () => {
    tables.properties = [listing({ max_guests: 6 })];
    const r = await assertQuotedTotal({ propertyId: PROPERTY_ID, checkIn: START, checkOut: END, clientTotal: 0 });
    const total = (r.details as { quote: { total: number } })?.quote?.total ?? r.data?.total ?? 0;

    tables.properties = [listing({ max_guests: 6 })];
    const token = signQuoteToken(
      { pid: PROPERTY_ID, ci: START, co: END, tot: total, ver: UPDATED_AT, exp: '2099-01-01T00:00:00.000Z', gc: 2 },
      SECRET,
    ) as string;

    tables.properties = [listing({ max_guests: 6 })];
    const result = await assertQuotedTotal({
      propertyId: PROPERTY_ID,
      checkIn: START,
      checkOut: END,
      clientTotal: total,
      quoteToken: token,
      guestCount: 2, // matches token's gc
    });

    expect(result.success).toBe(true);
  });
});
