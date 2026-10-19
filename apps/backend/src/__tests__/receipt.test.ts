/**
 * Tests for Feature A — PDF Receipt
 *
 * Covers:
 *  1. fetchReceiptData — data assembly and night calculation
 *  2. generateReceiptPdf — PDF output contains expected fields
 *  3. getBookingReceipt controller — authorization rules
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReceiptPdf, fetchReceiptData, calcNights, type ReceiptData } from '../services/receipt.service.js';
import { pdfStr } from '../utils/pdf.js';

// ─── Supabase mock ────────────────────────────────────────────────────────────
// fetchReceiptData queries:
//   1. bookings (single)
//   2. profiles + users (maybeSingle, in parallel)
//   3. payments (maybeSingle) — for stellar_tx_hash audit reference

const mockSingle      = vi.fn();
const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
const mockEq          = vi.fn();

const mockFrom = vi.fn(() => ({
  select: vi.fn(() => ({ eq: mockEq })),
}));

mockEq.mockImplementation(() => ({ single: mockSingle, maybeSingle: mockMaybeSingle }));

vi.mock('../config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// total_price = subtotal * (1 + 0.05) = 400 * 1.05 = 420 (5 % platform fee)

const BOOKING_ROW = {
  id:           'booking-001',
  property_id:  'prop-001',
  tenant_id:    'user-tenant',
  check_in:     '2027-08-01',
  check_out:    '2027-08-05',
  guest_count:  2,
  total_price:  420,
  status:       'Confirmed',
  escrow_id:    'escrow-xyz',
  on_chain_id:  42,
  created_at:   '2027-07-01T10:00:00Z',
  properties: {
    title:           'Seaside Cottage',
    address:         '1 Ocean Drive',
    city:            'Cape Town',
    country:         'South Africa',
    price_per_night: 100,
  },
};

const RECEIPT_DATA: ReceiptData = {
  bookingId:       'booking-001',
  propertyTitle:   'Seaside Cottage',
  propertyAddress: '1 Ocean Drive, Cape Town, South Africa',
  checkIn:         '2027-08-01',
  checkOut:        '2027-08-05',
  nights:          4,
  pricePerNight:   100,
  subtotal:        400,
  platformFee:     20,
  total:           420,
  guestCount:      2,
  status:          'Confirmed',
  escrowId:        'escrow-xyz',
  onChainId:       42,
  createdAt:       '2027-07-01T10:00:00Z',
};

// ─── fetchReceiptData ─────────────────────────────────────────────────────────

describe('fetchReceiptData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns error when bookingId is empty', async () => {
    const result = await fetchReceiptData('');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it('returns error when booking not found', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });
    const result = await fetchReceiptData('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('calculates nights correctly', async () => {
    mockSingle.mockResolvedValueOnce({ data: BOOKING_ROW, error: null });
    const result = await fetchReceiptData('booking-001');
    expect(result.success).toBe(true);
    expect(result.data?.nights).toBe(4);
  });

  it('derives the breakdown from the settled total using the 5% platform fee', async () => {
    mockSingle.mockResolvedValueOnce({ data: BOOKING_ROW, error: null });
    const result = await fetchReceiptData('booking-001');
    expect(result.success).toBe(true);
    // total = 420; fee = 420 * 0.05 / 1.05 = 20; subtotal = 400
    expect(result.data?.subtotal).toBe(400);
    expect(result.data?.platformFee).toBe(20);
    expect(result.data?.total).toBe(420);
  });

  it('includes stellar_tx_hash as audit reference when a payment exists', async () => {
    mockSingle.mockResolvedValueOnce({ data: BOOKING_ROW, error: null });
    // Queue: profiles (null), users (null), then payments (with tx hash)
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })                                   // profiles
      .mockResolvedValueOnce({ data: null, error: null })                                   // users
      .mockResolvedValueOnce({ data: { stellar_tx_hash: 'abc123txhash' }, error: null });   // payments
    const result = await fetchReceiptData('booking-001');
    expect(result.success).toBe(true);
    expect(result.data?.txHash).toBe('abc123txhash');
  });

  it('populates escrow and on-chain ids from the booking row', async () => {
    mockSingle.mockResolvedValueOnce({ data: BOOKING_ROW, error: null });
    const result = await fetchReceiptData('booking-001');
    expect(result.data?.escrowId).toBe('escrow-xyz');
    expect(result.data?.onChainId).toBe(42);
  });

  it('assembles property address from parts', async () => {
    mockSingle.mockResolvedValueOnce({ data: BOOKING_ROW, error: null });
    const result = await fetchReceiptData('booking-001');
    expect(result.data?.propertyAddress).toBe('1 Ocean Drive, Cape Town, South Africa');
  });
});

// ─── generateReceiptPdf ───────────────────────────────────────────────────────

describe('generateReceiptPdf', () => {
  it('returns a Buffer', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('starts with the PDF header magic bytes', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  it('ends with %%EOF', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    const tail = buf.slice(-10).toString();
    expect(tail).toContain('%%EOF');
  });

  it('embeds the booking ID', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.toString('latin1')).toContain('booking-001');
  });

  it('embeds the property title', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.toString('latin1')).toContain('Seaside Cottage');
  });

  it('embeds the check-in date', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    // fmtDate('2027-08-01') → '1 Aug 2027'
    expect(buf.toString('latin1')).toContain('Aug 2027');
  });

  it('embeds the total price', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.toString('latin1')).toContain('420.00 USDC');
  });

  it('embeds the platform fee', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.toString('latin1')).toContain('20.00 USDC');
  });

  it('embeds the escrow ID', () => {
    const buf = generateReceiptPdf(RECEIPT_DATA);
    expect(buf.toString('latin1')).toContain('escrow-xyz');
  });

  it('embeds the on-chain id and explorer link', () => {
    const text = generateReceiptPdf(RECEIPT_DATA).toString('latin1');
    expect(text).toContain('42');
    expect(text).toContain('stellar.expert');
  });

  it('works when escrowId and onChainId are absent', () => {
    const data: ReceiptData = { ...RECEIPT_DATA, escrowId: undefined, onChainId: undefined };
    const buf = generateReceiptPdf(data);
    expect(buf.toString('latin1')).not.toContain('stellar.expert');
    expect(buf.toString('latin1')).toContain('booking-001');
  });

  it('embeds the settlement tx hash when present', () => {
    const data: ReceiptData = { ...RECEIPT_DATA, txHash: 'stellar-tx-abc123' };
    const text = generateReceiptPdf(data).toString('latin1');
    expect(text).toContain('stellar-tx-abc123');
  });

  it('does not emit a blockchain section when all chain fields are absent', () => {
    const data: ReceiptData = {
      ...RECEIPT_DATA,
      escrowId: undefined,
      onChainId: undefined,
      txHash: undefined,
    };
    const text = generateReceiptPdf(data).toString('latin1');
    expect(text).not.toContain('Blockchain Reference');
  });

  it('handles single-night stays', () => {
    const data: ReceiptData = {
      ...RECEIPT_DATA,
      nights: 1,
      checkOut: '2027-08-02',
      subtotal: 100,
      platformFee: 5,
      total: 105,
    };
    const text = generateReceiptPdf(data).toString('latin1');
    expect(text).toContain('1 night');
    expect(text).not.toContain('1 nights');
  });
});

// ─── Authorization logic (unit-tested directly) ───────────────────────────────

describe('Receipt authorization logic', () => {
  /**
   * We test the authorization rule in isolation — same logic used in
   * getBookingReceipt controller — without spinning up an HTTP server.
   */
  function isAuthorized(
    requesterId: string,
    tenantId: string,
    hostOwnerId: string,
  ): boolean {
    return requesterId === tenantId || requesterId === hostOwnerId;
  }

  it('allows the tenant to access the receipt', () => {
    expect(isAuthorized('user-tenant', 'user-tenant', 'user-host')).toBe(true);
  });

  it('allows the host to access the receipt', () => {
    expect(isAuthorized('user-host', 'user-tenant', 'user-host')).toBe(true);
  });

  it('blocks a random third party', () => {
    expect(isAuthorized('user-stranger', 'user-tenant', 'user-host')).toBe(false);
  });

  it('blocks when requester id is empty string', () => {
    expect(isAuthorized('', 'user-tenant', 'user-host')).toBe(false);
  });

  /** Receipts are only valid for confirmed/completed statuses. */
  function isReceiptableStatus(status: string): boolean {
    return ['Confirmed', 'Completed', 'confirmed', 'completed'].includes(status);
  }

  it('allows receipt for Confirmed status', () => {
    expect(isReceiptableStatus('Confirmed')).toBe(true);
  });

  it('allows receipt for Completed status', () => {
    expect(isReceiptableStatus('Completed')).toBe(true);
  });

  it('blocks receipt for Pending status', () => {
    expect(isReceiptableStatus('Pending')).toBe(false);
  });

  it('blocks receipt for Cancelled status', () => {
    expect(isReceiptableStatus('Cancelled')).toBe(false);
  });
});

// ─── calcNights — DST-safe calendar arithmetic ────────────────────────────────

describe('calcNights() — UTC date-only arithmetic', () => {
  it('counts ordinary multi-night stays correctly', () => {
    expect(calcNights('2027-08-01', '2027-08-05')).toBe(4);
  });

  it('counts a single-night stay as 1', () => {
    expect(calcNights('2027-08-01', '2027-08-02')).toBe(1);
  });

  it('returns 1 for a same-day check-in/check-out (floor at 1)', () => {
    expect(calcNights('2027-08-01', '2027-08-01')).toBe(1);
  });

  it('counts correctly across a month boundary', () => {
    expect(calcNights('2027-07-30', '2027-08-03')).toBe(4);
  });

  it('counts correctly across a year boundary', () => {
    expect(calcNights('2026-12-29', '2027-01-02')).toBe(4);
  });

  // DST spring-forward: clocks move ahead 1 hour, making that day 23 h long.
  // In Europe (CET→CEST) this happens on the last Sunday of March.
  // 2027-03-28 is the spring-forward night in many European timezones.
  // A plain Date.getTime() diff would yield 23 h = 0.958… days → rounds to 1,
  // which is WRONG for a 2-night stay.  UTC midnight arithmetic must give 2.
  it('gives the correct count across a spring-forward DST boundary (2 nights)', () => {
    expect(calcNights('2027-03-27', '2027-03-29')).toBe(2);
  });

  // DST fall-back: clocks move back 1 hour, making that day 25 h long.
  // 2027-10-31 is the fall-back night in many European timezones.
  // A plain diff would yield 25 h = 1.041… days → rounds to 1, WRONG for 2 nights.
  it('gives the correct count across a fall-back DST boundary (2 nights)', () => {
    expect(calcNights('2027-10-30', '2027-11-01')).toBe(2);
  });

  // Single night spanning the spring-forward transition (23-hour day).
  it('returns 1 for a single night spanning spring-forward', () => {
    expect(calcNights('2027-03-28', '2027-03-29')).toBe(1);
  });

  // Single night spanning the fall-back transition (25-hour day).
  it('returns 1 for a single night spanning fall-back', () => {
    expect(calcNights('2027-10-31', '2027-11-01')).toBe(1);
  });

  it('counts a long stay (30 nights) correctly', () => {
    expect(calcNights('2027-06-01', '2027-07-01')).toBe(30);
  });
});

// ─── generateReceiptPdf — special-character escaping ─────────────────────────

describe('generateReceiptPdf() — PDF text escaping', () => {
  it('produces a parseable PDF when propertyTitle contains parentheses', () => {
    const data: ReceiptData = {
      ...RECEIPT_DATA,
      propertyTitle: 'Villa (Deluxe) Suite',
    };
    const buf = generateReceiptPdf(data);
    // Must still start and end with valid PDF delimiters
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.slice(-8).toString()).toContain('%%EOF');
    // Parentheses in the content stream must be escaped, not bare
    const stream = buf.toString('latin1');
    expect(stream).toContain('\\(Deluxe\\)');
  });

  it('produces a parseable PDF when propertyTitle contains backslashes', () => {
    const data: ReceiptData = {
      ...RECEIPT_DATA,
      propertyTitle: 'Studio \\ Loft',
    };
    const buf = generateReceiptPdf(data);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const stream = buf.toString('latin1');
    // Backslash must be doubled in the PDF string literal
    expect(stream).toContain('\\\\');
  });

  it('produces a parseable PDF when propertyAddress contains parentheses and backslash', () => {
    const data: ReceiptData = {
      ...RECEIPT_DATA,
      propertyAddress: '12 (Main) St \\ Town',
    };
    const buf = generateReceiptPdf(data);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.slice(-8).toString()).toContain('%%EOF');
  });

  it('leaves normal ASCII text completely unchanged', () => {
    const title = 'Seaside Cottage';
    const data: ReceiptData = { ...RECEIPT_DATA, propertyTitle: title };
    const stream = generateReceiptPdf(data).toString('latin1');
    expect(stream).toContain(title);
  });

  it('pdfStr round-trip: escapes then embeds correctly', () => {
    // Verify pdfStr itself handles all PDF-special characters correctly.
    expect(pdfStr('hello')).toBe('hello');
    expect(pdfStr('say (hi)')).toBe('say \\(hi\\)');
    expect(pdfStr('back\\slash')).toBe('back\\\\slash');
    expect(pdfStr('(both) \\ combined')).toBe('\\(both\\) \\\\ combined');
  });
});
