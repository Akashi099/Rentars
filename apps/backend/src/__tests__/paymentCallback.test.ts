/**
 * Tests for paymentCallback.service.ts — secure escrow callback verification.
 *
 * Closes #766 (Issue 042).
 *
 * Covers:
 *  1. Missing / invalid signatures              → rejected (401)
 *  2. Malformed payload                          → rejected (400)
 *  3. Stale or future timestamp                  → rejected (400)
 *  4. Provider account mismatch                  → rejected (422)
 *  5. Replay detection                           → harmless 200 with 'replayed'
 *  6. Booking not found                          → rejected (422)
 *  7. Amount mismatch                            → quarantined (422), audit trail recorded
 *  8. Valid callback                             → acknowledged exactly once (200)
 *  9. Internal transition failure               → quarantined (200)
 * 10. buildCallbackResponse — status mapping
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  verifyAndProcessCallback,
  buildCallbackResponse,
  type CallbackVerificationResult,
} from '../services/paymentCallback.service.js';

// ─── Payment service mocks ────────────────────────────────────────────────────

const mockTransitionPaymentStatus = vi.fn();
const mockMapProviderStatus       = vi.fn();
const mockHashEventPayload        = vi.fn();
const mockGetPaymentByBookingId   = vi.fn();

vi.mock('../services/payment.service.js', () => ({
  transitionPaymentStatus: mockTransitionPaymentStatus,
  mapProviderStatus:       mockMapProviderStatus,
  hashEventPayload:        mockHashEventPayload,
  getPaymentByBookingId:   mockGetPaymentByBookingId,
}));

// ─── Supabase mock ────────────────────────────────────────────────────────────
// isReplay:   .from('payment_callback_events').select('id').eq(...).gte(...).maybeSingle()
// recordEvent:.from('payment_callback_events').insert({...}).select()

const mockMaybeSingle   = vi.fn();
const mockInsertSelect  = vi.fn();
const mockInsert        = vi.fn(() => ({ select: mockInsertSelect }));
const mockGte           = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
const mockInnerEq       = vi.fn(() => ({ gte: mockGte }));
const mockSelectChain   = vi.fn(() => ({ eq: mockInnerEq }));

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelectChain,
      insert: mockInsert,
    })),
  },
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET      = 'test-webhook-secret-1234';
const PROVIDER_ID = 'trustless-work-provider-001';
const BOOKING_ID  = '11111111-1111-4111-8111-111111111111';
const AMOUNT      = '10000000'; // 10 USDC in stroops

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId:           'evt-001',
    timestamp:         new Date().toISOString(),
    status:            'funded',
    bookingId:         BOOKING_ID,
    amountStroops:     AMOUNT,
    providerAccountId: PROVIDER_ID,
    ...overrides,
  };
}

function makeRawBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

function sign(rawBody: Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function makePayment(amountOverride?: bigint) {
  return {
    id:            'payment-001',
    amount_stroops: amountOverride ?? BigInt(AMOUNT),
    booking_id:    BOOKING_ID,
  };
}

// ─── Default mock implementations (reset in beforeEach) ───────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // No replay by default
  mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  // Insert succeeds by default
  mockInsertSelect.mockResolvedValue({ data: null, error: null });
  // Hash is deterministic but value doesn't matter for these tests
  mockHashEventPayload.mockReturnValue('event-hash-abc');
  // Status mapping: provider 'funded' → canonical 'confirmed'
  mockMapProviderStatus.mockReturnValue('confirmed');
});

// ─── 1. Signature checks ──────────────────────────────────────────────────────

describe('verifyAndProcessCallback — signature', () => {
  it('rejects when signature header is absent', async () => {
    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const result  = await verifyAndProcessCallback(raw, undefined, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_signature');
    expect(result.httpStatus).toBe(401);
  });

  it('rejects when signature is wrong (tampering)', async () => {
    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const result  = await verifyAndProcessCallback(raw, 'deadbeefdeadbeef', payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_signature');
    expect(result.httpStatus).toBe(401);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw, 'wrong-secret');
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_signature');
    expect(result.httpStatus).toBe(401);
  });

  it('does not reach state transitions when the signature is invalid', async () => {
    const payload = makePayload();
    const raw     = makeRawBody(payload);
    await verifyAndProcessCallback(raw, 'badsig', payload, SECRET, PROVIDER_ID);
    expect(mockGetPaymentByBookingId).not.toHaveBeenCalled();
    expect(mockTransitionPaymentStatus).not.toHaveBeenCalled();
  });
});

// ─── 2. Payload validation ────────────────────────────────────────────────────

describe('verifyAndProcessCallback — payload validation', () => {
  it('rejects a body that is missing required fields', async () => {
    const bad = { eventId: 'e1' };
    const raw = makeRawBody(bad);
    const sig = sign(raw);
    const result = await verifyAndProcessCallback(raw, sig, bad, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_payload');
    expect(result.httpStatus).toBe(400);
  });

  it('rejects when amountStroops is not a numeric string', async () => {
    const payload = makePayload({ amountStroops: 'not-a-number' });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_payload');
    expect(result.httpStatus).toBe(400);
  });

  it('rejects when bookingId is not a valid UUID', async () => {
    const payload = makePayload({ bookingId: 'not-a-uuid' });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_payload');
    expect(result.httpStatus).toBe(400);
  });
});

// ─── 3. Timestamp tolerance ───────────────────────────────────────────────────

describe('verifyAndProcessCallback — timestamp', () => {
  it('rejects a timestamp more than 5 minutes in the past', async () => {
    const stale   = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
    const payload = makePayload({ timestamp: stale });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_timestamp');
    expect(result.httpStatus).toBe(400);
  });

  it('rejects a timestamp more than 5 minutes in the future', async () => {
    const future  = new Date(Date.now() + 6 * 60 * 1_000).toISOString();
    const payload = makePayload({ timestamp: future });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('invalid_timestamp');
    expect(result.httpStatus).toBe(400);
  });

  it('accepts a timestamp within the 5-minute tolerance window', async () => {
    const recent  = new Date(Date.now() - 2 * 60 * 1_000).toISOString();
    const payload = makePayload({ timestamp: recent });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: true, data: { replayed: false } });
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).not.toBe('invalid_timestamp');
  });
});

// ─── 4. Provider identity ─────────────────────────────────────────────────────

describe('verifyAndProcessCallback — provider identity', () => {
  it('rejects (422) when providerAccountId does not match the expected value', async () => {
    const payload = makePayload({ providerAccountId: 'intruder-account' });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('mismatch');
    expect(result.httpStatus).toBe(422);
  });

  it('does not transition state on identity mismatch', async () => {
    const payload = makePayload({ providerAccountId: 'intruder-account' });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(mockTransitionPaymentStatus).not.toHaveBeenCalled();
  });
});

// ─── 5. Replay detection ──────────────────────────────────────────────────────

describe('verifyAndProcessCallback — replay detection', () => {
  it('returns replayed (200) for a known event ID', async () => {
    // Simulate event already in the replay ledger
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'existing-entry' }, error: null });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('replayed');
    expect(result.httpStatus).toBe(200);
  });

  it('does not call transition or insert on replay', async () => {
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: 'existing-entry' }, error: null });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(mockTransitionPaymentStatus).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

// ─── 6 & 7. Booking lookup and amount check ───────────────────────────────────

describe('verifyAndProcessCallback — booking and amount', () => {
  it('returns mismatch (422) when the booking is not found', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(null);

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(result.status).toBe('mismatch');
    expect(result.httpStatus).toBe(422);
  });

  it('transitions to under_review and records event on amount mismatch', async () => {
    // Payment expects a different amount
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment(BigInt('99999999')));
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: true, data: { replayed: false } });

    const payload = makePayload({ amountStroops: AMOUNT }); // 10_000_000 ≠ 99_999_999
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    expect(result.status).toBe('mismatch');
    expect(result.httpStatus).toBe(422);
    expect(mockTransitionPaymentStatus).toHaveBeenCalledWith(
      'payment-001',
      'under_review',
      expect.objectContaining({ _reason: 'amount_mismatch' }),
    );
    // Must still record in the replay ledger to prevent re-processing
    expect(mockInsert).toHaveBeenCalled();
  });

  it('does not transition state when the booking is not found', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(null);

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);
    expect(mockTransitionPaymentStatus).not.toHaveBeenCalled();
  });
});

// ─── 8. Valid callback ────────────────────────────────────────────────────────

describe('verifyAndProcessCallback — valid new event', () => {
  it('acknowledges (200) a correctly signed, in-window, amount-matching event', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: true, data: { replayed: false } });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    expect(result.status).toBe('acknowledged');
    expect(result.httpStatus).toBe(200);
  });

  it('transitions state exactly once and records the event in the ledger', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: true, data: { replayed: false } });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    expect(mockTransitionPaymentStatus).toHaveBeenCalledOnce();
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('returns replayed when the state machine detects idempotent re-delivery', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: true, data: { replayed: true } });

    const payload = makePayload({ eventId: 'evt-idempotent' });
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    expect(result.status).toBe('replayed');
    expect(result.httpStatus).toBe(200);
  });
});

// ─── 9. Internal transition failure (quarantine) ─────────────────────────────

describe('verifyAndProcessCallback — internal failure', () => {
  it('returns quarantined (200) to the provider when transition fails internally', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: false, error: 'Invalid state transition' });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    const result  = await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    // Provider receives 200 — we accepted the webhook; our internal state is separate
    expect(result.status).toBe('quarantined');
    expect(result.httpStatus).toBe(200);
  });

  it('still records the event in the ledger even when transition fails', async () => {
    mockGetPaymentByBookingId.mockResolvedValueOnce(makePayment());
    mockTransitionPaymentStatus.mockResolvedValueOnce({ success: false, error: 'Invalid state transition' });

    const payload = makePayload();
    const raw     = makeRawBody(payload);
    const sig     = sign(raw);
    await verifyAndProcessCallback(raw, sig, payload, SECRET, PROVIDER_ID);

    expect(mockInsert).toHaveBeenCalled();
  });
});

// ─── 10. buildCallbackResponse ────────────────────────────────────────────────

describe('buildCallbackResponse', () => {
  it('maps acknowledged to { status: "acknowledged" }', () => {
    const r: CallbackVerificationResult = {
      status: 'acknowledged', httpStatus: 200, message: 'Event acknowledged',
    };
    expect(buildCallbackResponse(r)).toEqual({ status: 'acknowledged', message: 'Event acknowledged' });
  });

  it('maps replayed to { status: "replayed" }', () => {
    const r: CallbackVerificationResult = {
      status: 'replayed', httpStatus: 200, message: 'Event already processed',
    };
    expect(buildCallbackResponse(r)).toEqual({ status: 'replayed', message: 'Event already processed' });
  });

  it('maps all error statuses to { status: "error" }', () => {
    const errorStatuses: Array<CallbackVerificationResult['status']> = [
      'invalid_signature',
      'invalid_timestamp',
      'invalid_payload',
      'mismatch',
      'quarantined',
    ];
    for (const status of errorStatuses) {
      const r: CallbackVerificationResult = { status, httpStatus: 400, message: 'details' };
      expect(buildCallbackResponse(r).status, `expected "error" for status="${status}"`).toBe('error');
    }
  });

  it('preserves the message from the verification result', () => {
    const r: CallbackVerificationResult = {
      status: 'invalid_signature', httpStatus: 401, message: 'Signature verification failed',
    };
    expect(buildCallbackResponse(r).message).toBe('Signature verification failed');
  });
});
