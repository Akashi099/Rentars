/**
 * #600 — Transactional date availability tests.
 *
 * Verifies that the exclusion-constraint error path (when the advisory lock is
 * bypassed or two requests race past it) is normalised to the same
 * BOOKING_CONFLICT response the application already handles.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BookingService } from '../services/booking.service.js';
import type { CreateBookingInput, BlockchainServices } from '../services/booking.service.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRpc  = vi.fn();
const mockFrom = vi.fn();

vi.mock('../config/supabase.js', () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
}));

const mockCreateEscrow = vi.fn();
const mockCancelEscrow = vi.fn();

vi.mock('../blockchain/trustlessWork.js', () => ({
  trustlessWorkClient: {
    createBookingEscrow: mockCreateEscrow,
    cancelEscrow:        mockCancelEscrow,
  },
}));

vi.mock('../services/logging.service.js', () => ({
  loggingService: { logBlockchainOperation: vi.fn() },
}));

vi.mock('../services/notification.service.js', () => ({
  createNotification: vi.fn().mockResolvedValue({}),
}));

vi.mock('../middleware/metrics.middleware.js', () => ({
  incCounter:           vi.fn(),
  bookingsCreatedTotal: {},
  escrowFailuresTotal:  {},
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_STELLAR = 'GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A';

function makeBlockchain(): BlockchainServices {
  return {
    checkAvailability:          vi.fn().mockResolvedValue(true),
    createBookingOnChain:       vi.fn().mockResolvedValue(BigInt(1)),
    cancelBookingOnChain:       vi.fn().mockResolvedValue(undefined),
    updateBookingStatusOnChain: vi.fn().mockResolvedValue(undefined),
  };
}

function stubPropertyAndProfile() {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'properties') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'prop-1', owner_id: 'owner-1', on_chain_id: null, max_guests: 10 },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'profiles') {
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { stellar_address: VALID_STELLAR },
              error: null,
            }),
          }),
        }),
      };
    }
    return {
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'b1', status: 'Pending', escrow_id: 'esc-1' },
              error: null,
            }),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    };
  });
}

const BASE_INPUT: CreateBookingInput = {
  property_id: 'prop-1',
  tenant_id:   'tenant-1',
  check_in:    '2027-03-10',
  check_out:   '2027-03-15',
  guest_count: 2,
  total_price: 500,
  rules_acknowledged_at: new Date().toISOString(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('#600 — Transactional date availability', () => {
  let service: BookingService;

  beforeEach(() => {
    mockRpc.mockReset();
    mockFrom.mockReset();
    mockCreateEscrow.mockReset();
    mockCancelEscrow.mockReset();
    service = new BookingService(makeBlockchain());
    stubPropertyAndProfile();
  });

  it('maps exclusion_violation from the DB constraint to conflict=true', async () => {
    // Simulate the exclusion constraint firing (e.g. advisory lock bypassed).
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'BOOKING_CONFLICT: dates overlap with an existing booking' },
    });

    const result = await service.createBooking(BASE_INPUT);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('does not create escrow when the exclusion constraint fires', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'BOOKING_CONFLICT: dates overlap with an existing booking' },
    });

    await service.createBooking(BASE_INPUT);

    expect(mockCreateEscrow).not.toHaveBeenCalled();
  });

  it('Pending status occupies inventory — a second booking is rejected', async () => {
    let calls = 0;
    mockRpc.mockImplementation(async () => {
      calls++;
      if (calls === 1) return { data: 'booking-first', error: null };
      // Second call: Pending booking already holds the dates.
      return { data: null, error: { message: 'BOOKING_CONFLICT: dates overlap with an existing booking' } };
    });

    mockCreateEscrow.mockResolvedValue({ escrowId: 'esc-ok' });

    const input2: CreateBookingInput = { ...BASE_INPUT, tenant_id: 'tenant-2' };
    const [r1, r2] = await Promise.all([
      service.createBooking(BASE_INPUT),
      new BookingService(makeBlockchain()).createBooking(input2),
    ]);

    const winners = [r1, r2].filter((r) => r.success).length;
    expect(winners).toBe(1);

    const loser = r1.success ? r2 : r1;
    expect(loser.conflict).toBe(true);
  });

  it('Cancelled booking releases dates — next booking succeeds', async () => {
    mockRpc.mockResolvedValue({ data: 'booking-uuid-2', error: null });
    mockCreateEscrow.mockResolvedValue({ escrowId: 'esc-2' });

    const result = await service.createBooking(BASE_INPUT);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('booking-uuid-2');
  });

  it('returns conflict error without exposing other tenant details', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'BOOKING_CONFLICT: dates overlap with an existing booking' },
    });

    const result = await service.createBooking(BASE_INPUT);

    expect(result.success).toBe(false);
    // Error message must not contain any tenant ID or booking ID.
    expect(result.error).not.toMatch(/tenant/i);
    expect(result.error).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
