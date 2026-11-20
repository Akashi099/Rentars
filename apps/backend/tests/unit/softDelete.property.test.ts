/**
 * Soft-Delete Tests for Property Listings
 *
 * Covers all acceptance criteria:
 *   1. deleteProperty sets deleted_at instead of removing the row
 *   2. Soft-deleted listings are hidden from public search / property reads
 *   3. New bookings against soft-deleted properties are rejected
 *   4. Existing bookings remain readable after soft-delete
 *   5. Reviews remain readable after soft-delete (getPropertyForReview works)
 *   6. Owner can retrieve their own deleted listing via includeDeleted flag
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ──────────────────────────────────────────────────────────────
// mock.module must be called before any service imports that use supabase.
const mockFrom = mock((_: string) => ({}));
const mockRpc  = mock(async () => ({ data: 'reserved-booking-id', error: null }));

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

// ── Cache mock (no-op) ─────────────────────────────────────────────────────────
mock.module('../../src/services/cache.service.js', () => ({
  get: mock(async () => null),
  set: mock(async () => {}),
  del: mock(async () => {}),
}));

// ── TrustlessWork mock ─────────────────────────────────────────────────────────
const mockCreateEscrow = mock(async () => ({ escrowId: 'escrow-soft-delete-test' }));
const mockCancelEscrow = mock(async () => {});

mock.module('../../src/blockchain/trustlessWork.js', () => ({
  trustlessWorkClient: {
    createBookingEscrow: mockCreateEscrow,
    cancelEscrow:        mockCancelEscrow,
  },
}));

// ── Logging mock ───────────────────────────────────────────────────────────────
mock.module('../../src/services/logging.service.js', () => ({
  loggingService: { logBlockchainOperation: mock(() => {}) },
}));

// ── Notification mock ──────────────────────────────────────────────────────────
mock.module('../../src/services/notification.service.js', () => ({
  createNotification: mock(async () => ({ success: true })),
  getPreferences:     mock(async () => ({})),
}));

// ── Metrics mock ───────────────────────────────────────────────────────────────
mock.module('../../src/middleware/metrics.middleware.js', () => ({
  incCounter:           mock(() => {}),
  bookingsCreatedTotal: {},
  escrowFailuresTotal:  {},
}));

// ── Service imports (after mocks) ──────────────────────────────────────────────
import {
  deleteProperty,
  getAllProperties,
  getPropertyById,
  getPropertyBySlug,
  getFeaturedProperties,
  searchProperties,
  getPropertyForReview,
  type Property,
} from '../../src/services/property.service.js';

import {
  BookingService,
  type BlockchainServices,
  type CreateBookingInput,
} from '../../src/services/booking.service.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const ACTIVE_PROPERTY: Property = {
  id:              'prop-active-001',
  owner_id:        'owner-001',
  title:           'Sunny Beach House',
  description:     'Great views',
  price_per_night: 150,
  status:          'available',
  city:            'Miami',
  country:         'USA',
  slug:            'sunny-beach-house-miami-prop-active-001',
  deleted_at:      null,
  created_at:      '2026-01-01T00:00:00Z',
};

const DELETED_PROPERTY: Property = {
  ...ACTIVE_PROPERTY,
  id:         'prop-deleted-001',
  deleted_at: '2026-06-01T10:00:00Z',
  slug:       'sunny-beach-house-miami-prop-deleted-001',
};

// ── Helper: build a minimal BlockchainServices stub ───────────────────────────
function makeBlockchain(overrides: Partial<BlockchainServices> = {}): BlockchainServices {
  return {
    checkAvailability:          mock(async () => true),
    createBookingOnChain:       mock(async () => BigInt(1)),
    cancelBookingOnChain:       mock(async () => {}),
    updateBookingStatusOnChain: mock(async () => {}),
    ...overrides,
  };
}

// ── deleteProperty ─────────────────────────────────────────────────────────────

describe('deleteProperty (soft-delete)', () => {
  beforeEach(() => mockFrom.mockClear());

  // deleteProperty first reads the listing (owner, tombstone) and any active
  // bookings, then writes deleted_at, then re-checks bookings. Route by table.
  const routeDelete = (updateResult: { error: { message: string } | null }, onUpdate?: (p: Record<string, unknown>) => void) => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'bookings') {
        const q: Record<string, unknown> = {};
        q.select = mock(() => q);
        q.eq = mock(() => q);
        q.in = mock(() => q);
        q.gte = mock(() => q);
        q.limit = mock(async () => ({ data: [], error: null }));
        return q;
      }
      return {
        select: mock(() => ({
          eq: mock(() => ({
            maybeSingle: mock(async () => ({
              data: { id: 'prop-active-001', owner_id: 'owner-1', deleted_at: null },
              error: null,
            })),
          })),
        })),
        update: mock((payload: Record<string, unknown>) => {
          onUpdate?.(payload);
          return {
            eq: mock(() => ({
              is: mock(async () => updateResult),
            })),
          };
        }),
      };
    });
  };

  it('should update deleted_at instead of removing the row', async () => {
    let updatedPayload: Record<string, unknown> | null = null;
    routeDelete({ error: null }, (p) => {
      updatedPayload = p;
    });

    const result = await deleteProperty('prop-active-001');
    expect(result.success).toBe(true);

    // Must set deleted_at, NOT call .delete()
    expect(updatedPayload).not.toBeNull();
    expect(typeof updatedPayload!['deleted_at']).toBe('string');
    // deleted_at should be a recent ISO timestamp
    const ts = new Date(updatedPayload!['deleted_at'] as string).getTime();
    expect(ts).toBeGreaterThan(Date.now() - 5_000);
  });

  it('should return error when database update fails', async () => {
    routeDelete({ error: { message: 'DB write failed' } });

    const result = await deleteProperty('prop-active-001');
    expect(result.success).toBe(false);
    expect(result.error).toBe('DB write failed');
  });

  it('should return error when no id is provided', async () => {
    const result = await deleteProperty('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property ID is required');
  });
});

// ── getAllProperties — hides soft-deleted ──────────────────────────────────────

describe('getAllProperties — soft-delete filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should apply is(deleted_at, null) filter', async () => {
    let filterCalledWithNull = false;

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        is: mock((col: string, val: unknown) => {
          if (col === 'deleted_at' && val === null) filterCalledWithNull = true;
          return {
            order: mock(async () => ({ data: [ACTIVE_PROPERTY], error: null })),
          };
        }),
      })),
    }));

    const result = await getAllProperties();
    expect(result.success).toBe(true);
    expect(filterCalledWithNull).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data![0].id).toBe('prop-active-001');
  });
});

// ── getPropertyById — hides soft-deleted ──────────────────────────────────────

describe('getPropertyById — soft-delete visibility', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should return error for soft-deleted property on public read', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: DELETED_PROPERTY, error: null })),
        })),
      })),
    }));

    const result = await getPropertyById('prop-deleted-001');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });

  it('should return error for soft-deleted property even with a different requesterId', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: DELETED_PROPERTY, error: null })),
        })),
      })),
    }));

    const result = await getPropertyById('prop-deleted-001', 'some-other-user');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });

  it('should return soft-deleted property to the owner when includeDeleted=true', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'properties') {
        return {
          select: mock(() => ({
            eq: mock(() => ({
              single: mock(async () => ({ data: DELETED_PROPERTY, error: null })),
            })),
          })),
        };
      }
      // property_images
      return {
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              order: mock(async () => ({ data: [], error: null })),
            })),
          })),
        })),
      };
    });

    const result = await getPropertyById('prop-deleted-001', 'owner-001', true);
    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('prop-deleted-001');
    expect(result.data!.deleted_at).toBeTruthy();
  });

  it('should NOT allow a different user to retrieve deleted listing with includeDeleted=true', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: DELETED_PROPERTY, error: null })),
        })),
      })),
    }));

    const result = await getPropertyById('prop-deleted-001', 'different-owner', true);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });

  it('should return active property normally', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'properties') {
        return {
          select: mock(() => ({
            eq: mock(() => ({
              single: mock(async () => ({ data: ACTIVE_PROPERTY, error: null })),
            })),
          })),
        };
      }
      return {
        select: mock(() => ({
          eq: mock(() => ({
            eq: mock(() => ({
              order: mock(async () => ({ data: [], error: null })),
            })),
          })),
        })),
      };
    });

    const result = await getPropertyById('prop-active-001');
    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('prop-active-001');
  });
});

// ── getPropertyBySlug — hides soft-deleted ─────────────────────────────────────

describe('getPropertyBySlug — soft-delete filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should apply is(deleted_at, null) filter', async () => {
    let filterCalledWithNull = false;

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          is: mock((col: string, val: unknown) => {
            if (col === 'deleted_at' && val === null) filterCalledWithNull = true;
            return {
              single: mock(async () => ({ data: ACTIVE_PROPERTY, error: null })),
            };
          }),
        })),
      })),
    }));

    const result = await getPropertyBySlug('sunny-beach-house-miami-prop-active-001');
    expect(result.success).toBe(true);
    expect(filterCalledWithNull).toBe(true);
  });

  it('should return not-found for slug that matches a deleted property', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          is: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'Not found' } })),
          })),
        })),
      })),
    }));

    const result = await getPropertyBySlug('sunny-beach-house-miami-prop-deleted-001');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });
});

// ── getFeaturedProperties — hides soft-deleted ─────────────────────────────────

describe('getFeaturedProperties — soft-delete filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should apply is(deleted_at, null) filter on featured query', async () => {
    let softDeleteFilterApplied = false;
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    const featuredProp = { ...ACTIVE_PROPERTY, featured_until: futureDate, featured_weight: 10 };

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          is: mock((col: string, val: unknown) => {
            if (col === 'deleted_at' && val === null) softDeleteFilterApplied = true;
            return {
              not: mock(() => ({
                gt: mock(() => ({
                  order: mock(() => ({
                    order: mock(() => ({
                      limit: mock(async () => ({ data: [featuredProp], error: null })),
                    })),
                  })),
                })),
              })),
            };
          }),
        })),
      })),
    }));

    const result = await getFeaturedProperties();
    expect(result.success).toBe(true);
    expect(softDeleteFilterApplied).toBe(true);
  });
});

// ── searchProperties — hides soft-deleted ──────────────────────────────────────

describe('searchProperties — soft-delete filter', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should apply is(deleted_at, null) before other filters', async () => {
    let softDeleteFilterApplied = false;

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        is: mock((col: string, val: unknown) => {
          if (col === 'deleted_at' && val === null) softDeleteFilterApplied = true;
          return {
            ilike: mock(() => ({
              order: mock(async () => ({ data: [ACTIVE_PROPERTY], error: null })),
            })),
          };
        }),
      })),
    }));

    const result = await searchProperties({ city: 'Miami' });
    expect(result.success).toBe(true);
    expect(softDeleteFilterApplied).toBe(true);
  });
});

// ── getPropertyForReview — works on deleted properties ─────────────────────────

describe('getPropertyForReview — historical access', () => {
  beforeEach(() => mockFrom.mockClear());

  it('should return a soft-deleted property for review display', async () => {
    const minimalDeleted = {
      id:         DELETED_PROPERTY.id,
      title:      DELETED_PROPERTY.title,
      slug:       DELETED_PROPERTY.slug,
      deleted_at: DELETED_PROPERTY.deleted_at,
    };

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: minimalDeleted, error: null })),
        })),
      })),
    }));

    const result = await getPropertyForReview('prop-deleted-001');
    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('prop-deleted-001');
    expect(result.data!.title).toBe('Sunny Beach House');
    // deleted_at is present — caller knows the listing has been removed
    expect(result.data!.deleted_at).toBeTruthy();
  });

  it('should also return an active property', async () => {
    const minimal = {
      id:         ACTIVE_PROPERTY.id,
      title:      ACTIVE_PROPERTY.title,
      slug:       ACTIVE_PROPERTY.slug,
      deleted_at: null,
    };

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: minimal, error: null })),
        })),
      })),
    }));

    const result = await getPropertyForReview('prop-active-001');
    expect(result.success).toBe(true);
    expect(result.data!.deleted_at).toBeNull();
  });

  it('should return error if property id not found', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: null, error: { message: 'Not found' } })),
        })),
      })),
    }));

    const result = await getPropertyForReview('non-existent');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Property not found');
  });
});

// ── BookingService.createBooking — rejects soft-deleted property ────────────────

describe('BookingService.createBooking — soft-deleted property rejection', () => {
  let bookingService: BookingService;

  const validInput: CreateBookingInput = {
    property_id:           'prop-deleted-001',
    tenant_id:             'tenant-001',
    check_in:              '2026-09-01',
    check_out:             '2026-09-05',
    guest_count:           2,
    total_price:           600,
    rules_acknowledged_at: new Date().toISOString(),
  };

  beforeEach(() => {
    mockFrom.mockClear();
    mockRpc.mockClear();
    mockCreateEscrow.mockClear();
    mockCancelEscrow.mockClear();
    bookingService = new BookingService(makeBlockchain());
  });

  it('should reject booking when property is soft-deleted', async () => {
    const deletedPropertyRow = {
      id:             'prop-deleted-001',
      owner_id:       'owner-001',
      on_chain_id:    null,
      max_guests:     4,
      min_nights:     1,
      max_nights:     null,
      check_in_time:  null,
      check_out_time: null,
      deleted_at:     '2026-06-01T10:00:00Z',
    };

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: deletedPropertyRow, error: null })),
        })),
      })),
    }));

    const result = await bookingService.createBooking(validInput);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no longer available/i);
  });

  it('should NOT show soft-delete error when property is active', async () => {
    // For active property, the soft-delete guard should NOT trigger.
    // Other guards (Stellar addresses) will fail in this unit test environment
    // but the error should not be "no longer available".
    const activePropertyRow = {
      id:             'prop-active-001',
      owner_id:       'owner-001',
      on_chain_id:    null,
      max_guests:     4,
      min_nights:     1,
      max_nights:     null,
      check_in_time:  null,
      check_out_time: null,
      deleted_at:     null,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'properties') {
        return {
          select: mock(() => ({
            eq: mock(() => ({
              single: mock(async () => ({ data: activePropertyRow, error: null })),
            })),
          })),
        };
      }
      // profiles — return null stellar address to fail the Stellar check,
      // not the soft-delete check
      return {
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: { stellar_address: null }, error: null })),
          })),
        })),
      };
    });

    const result = await bookingService.createBooking({
      ...validInput,
      property_id: 'prop-active-001',
    });

    expect(result.success).toBe(false);
    // Error should be about Stellar, not soft-delete
    expect(result.error).not.toMatch(/no longer available/i);
  });

  it('should still allow reading existing bookings after property is soft-deleted', async () => {
    const existingBooking = {
      id:          'booking-historical-001',
      property_id: 'prop-deleted-001',
      tenant_id:   'tenant-001',
      check_in:    '2026-04-01',
      check_out:   '2026-04-05',
      total_price: 600,
      status:      'Completed',
    };

    mockFrom.mockImplementation(() => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: existingBooking, error: null })),
        })),
      })),
    }));

    const result = await bookingService.getBookingById('booking-historical-001');
    expect(result.success).toBe(true);
    expect(result.data!.id).toBe('booking-historical-001');
    expect(result.data!.property_id).toBe('prop-deleted-001');
    expect(result.data!.status).toBe('Completed');
  });
});
