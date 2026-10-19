/**
 * #755 — Listing revisions and booking snapshots.
 *
 * Verifies that the terms captured for a booking carry the booking-relevant
 * listing fields and the revision in effect at booking time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tables, resetTables, supabaseMock } from './support/supabaseChainMock.js';

vi.mock('../config/supabase.js', () => ({ supabase: supabaseMock }));

vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

import { captureListingTermsSnapshot } from '../services/property.service.js';

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const UPDATED_AT = '2026-10-01T10:00:00.000Z';

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPERTY_ID,
    owner_id: '22222222-2222-4222-8222-222222222222',
    price_per_night: 100,
    max_guests: 2,
    updated_at: UPDATED_AT,
    min_nights: 1,
    max_nights: null,
    check_in_time: '15:00:00',
    check_out_time: '11:00:00',
    ...overrides,
  };
}

beforeEach(() => {
  resetTables();
});

describe('captureListingTermsSnapshot', () => {
  it('captures booking-relevant fields with the latest revision number', async () => {
    tables.properties = [listing({ min_nights: 2, max_nights: 14 })];
    tables.property_versions = [{ version_number: 4 }];

    const result = await captureListingTermsSnapshot(PROPERTY_ID);

    expect(result.success).toBe(true);
    expect(result.data?.revision).toBe(4);
    expect(result.data?.terms).toMatchObject({
      price_per_night: 100,
      min_nights: 2,
      max_nights: 14,
      check_in_time: '15:00:00',
      listing_updated_at: UPDATED_AT,
    });
    expect(result.data?.terms).not.toHaveProperty('owner_id');
  });

  it('uses revision 0 for a listing that has never been versioned', async () => {
    tables.properties = [listing()];
    tables.property_versions = [];

    const result = await captureListingTermsSnapshot(PROPERTY_ID);

    expect(result.data?.revision).toBe(0);
  });

  it('fails cleanly when the listing does not exist', async () => {
    tables.properties = [];

    const result = await captureListingTermsSnapshot(PROPERTY_ID);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });
});
