/**
 * #752 — Resumable listing drafts.
 *
 * Verifies:
 *  1. Drafts and moderation-hidden listings are not public.
 *  2. Publishing is idempotent and reports missing fields before going live.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tables, resetTables, supabaseMock } from './support/supabaseChainMock.js';

vi.mock('../config/supabase.js', () => ({ supabase: supabaseMock }));

vi.mock('../services/cache.service.js', () => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  del: vi.fn().mockResolvedValue(undefined),
}));

import { isPubliclyReadable, getPublishReadiness, publishDraft } from '../services/property.service.js';

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PROPERTY_ID,
    owner_id: OWNER_ID,
    title: 'Harbour Studio',
    status: 'available',
    draft_status: 'active',
    moderation_state: 'visible',
    deleted_at: null,
    price_per_night: 100,
    updated_at: '2026-10-01T10:00:00.000Z',
    city: 'Lisbon',
    country: 'Portugal',
    bedrooms: 0,
    bathrooms: 1,
    max_guests: 2,
    property_type: 'studio',
    ...overrides,
  };
}

beforeEach(() => {
  resetTables();
});

describe('isPubliclyReadable', () => {
  it('allows active, visible listings', () => {
    expect(isPubliclyReadable({ status: 'available', draft_status: 'active', moderation_state: 'visible' })).toBe(true);
  });

  it('hides host drafts, including the legacy status marker', () => {
    expect(isPubliclyReadable({ status: 'available', draft_status: 'draft', moderation_state: 'visible' })).toBe(false);
    expect(isPubliclyReadable({ status: 'draft', draft_status: 'active', moderation_state: 'visible' })).toBe(false);
  });

  it('hides listings hidden by moderation', () => {
    expect(isPubliclyReadable({ status: 'available', draft_status: 'active', moderation_state: 'hidden' })).toBe(false);
  });
});

describe('getPublishReadiness', () => {
  it('treats a zero bedroom count as a real value (studios)', () => {
    const result = getPublishReadiness(listing() as never, 1);
    expect(result.ready).toBe(true);
    expect(result.missingFields).toEqual([]);
  });

  it('reports missing fields and the absence of photos', () => {
    const result = getPublishReadiness(listing({ city: null, price_per_night: null }) as never, 0);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toEqual(expect.arrayContaining(['city', 'price_per_night', 'images']));
  });
});

describe('publishDraft', () => {
  it('returns an already-active listing unchanged, so retries are safe', async () => {
    tables.properties = [listing({ draft_status: 'active' })];

    const result = await publishDraft(OWNER_ID, PROPERTY_ID);

    expect(result.success).toBe(true);
    expect(result.data?.draft_status).toBe('active');
  });

  it('refuses to publish an incomplete draft and names what is missing', async () => {
    tables.properties = [listing({ draft_status: 'draft', city: null })];
    tables.property_images = [];

    const result = await publishDraft(OWNER_ID, PROPERTY_ID);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(422);
    expect(result.error).toContain('city');
    expect(result.error).toContain('images');
  });

  it('returns not found for a draft owned by someone else', async () => {
    tables.properties = [];

    const result = await publishDraft('99999999-9999-4999-8999-999999999999', PROPERTY_ID);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(404);
  });
});
