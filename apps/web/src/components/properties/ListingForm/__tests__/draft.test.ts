/**
 * Draft lifecycle (#919): owner scoping, expiry, versioning, invalid-data handling,
 * and the guarantee that photos and unanswered prompts never lose or overwrite a draft.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAFT_SCHEMA_VERSION,
  DRAFT_TTL_MS,
  clearDraft,
  draftKeyFor,
  loadDraft,
  readDraft,
  sanitizeRestoredFields,
  serializeDraft,
  summarizeDraft,
  writeDraft,
} from '../draft';

const OWNER = 'GOWNER111';
const OTHER = 'GOTHER222';
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  get size() {
    return this.map.size;
  }
}

function rawDraft(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: DRAFT_SCHEMA_VERSION,
    ownerKey: OWNER,
    savedAt: NOW - 60_000,
    currentStep: 'pricing',
    formData: { title: 'Sunny loft', pricePerNight: 120, amenities: ['wifi'] },
    ...overrides,
  });
}

describe('draftKeyFor', () => {
  it('scopes the key to the owner', () => {
    expect(draftKeyFor(OWNER)).not.toBe(draftKeyFor(OTHER));
  });

  it('returns no key when the host is not identified, so nothing is saved', () => {
    expect(draftKeyFor(null)).toBeNull();
    expect(draftKeyFor('   ')).toBeNull();
  });
});

describe('writeDraft / readDraft round trip', () => {
  it('stores and restores a draft for the same owner', () => {
    const storage = new MemoryStorage();
    writeDraft(storage, {
      ownerKey: OWNER,
      currentStep: 'location',
      formData: { title: 'Loft', images: [] as unknown as File[] },
      now: NOW,
    });

    const result = readDraft(storage, OWNER, NOW + 1000);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.draft.formData.title).toBe('Loft');
      expect(result.draft.currentStep).toBe('location');
      expect(result.draft.needsAttention).toContain('photos');
    }
  });

  it('never persists photos', () => {
    const storage = new MemoryStorage();
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    writeDraft(storage, {
      ownerKey: OWNER,
      currentStep: 'photos',
      formData: { images: [file] },
      now: NOW,
    });
    const stored = JSON.parse(storage.getItem(draftKeyFor(OWNER)!)!);
    expect(stored.formData.images).toBeUndefined();
  });

  it('keeps one host’s draft separate from another’s on a shared browser', () => {
    const storage = new MemoryStorage();
    writeDraft(storage, {
      ownerKey: OWNER,
      currentStep: 'basic',
      formData: { title: 'Owner draft' },
      now: NOW,
    });
    writeDraft(storage, {
      ownerKey: OTHER,
      currentStep: 'basic',
      formData: { title: 'Other draft' },
      now: NOW,
    });

    const mine = readDraft(storage, OWNER, NOW);
    expect(mine.status === 'ok' && mine.draft.formData.title).toBe('Owner draft');
    expect(storage.size).toBe(2);
  });

  it('does not write anything without an owner', () => {
    const storage = new MemoryStorage();
    expect(
      writeDraft(storage, { ownerKey: null, currentStep: 'basic', formData: {}, now: NOW })
    ).toBe(false);
    expect(storage.size).toBe(0);
  });

  it('clears only the owner’s draft', () => {
    const storage = new MemoryStorage();
    writeDraft(storage, { ownerKey: OWNER, currentStep: 'basic', formData: {}, now: NOW });
    writeDraft(storage, { ownerKey: OTHER, currentStep: 'basic', formData: {}, now: NOW });
    clearDraft(storage, OWNER);
    expect(readDraft(storage, OWNER, NOW).status).toBe('none');
    expect(readDraft(storage, OTHER, NOW).status).toBe('ok');
  });
});

describe('loadDraft — versioning, ownership and corruption', () => {
  it('returns none for an empty slot', () => {
    expect(loadDraft(null, OWNER, NOW)).toEqual({ status: 'none' });
  });

  it('treats corrupt JSON as unreadable, never throws', () => {
    expect(loadDraft('{not json', OWNER, NOW)).toEqual({ status: 'unreadable' });
    expect(loadDraft('"a string"', OWNER, NOW)).toEqual({ status: 'unreadable' });
  });

  it('does not restore a layout from an older or unknown schema version', () => {
    expect(loadDraft(rawDraft({ schemaVersion: 1 }), OWNER, NOW)).toEqual({ status: 'unreadable' });
    expect(loadDraft(rawDraft({ schemaVersion: 99 }), OWNER, NOW)).toEqual({
      status: 'unreadable',
    });
  });

  it('refuses a draft that names a different owner', () => {
    expect(loadDraft(rawDraft({ ownerKey: OTHER }), OWNER, NOW)).toEqual({ status: 'unreadable' });
  });

  it('expires drafts after the TTL', () => {
    const old = loadDraft(rawDraft({ savedAt: NOW - DRAFT_TTL_MS - 1 }), OWNER, NOW);
    expect(old.status).toBe('expired');
  });

  it('still restores a draft that is exactly at the TTL boundary', () => {
    const edge = loadDraft(rawDraft({ savedAt: NOW - DRAFT_TTL_MS }), OWNER, NOW);
    expect(edge.status).toBe('ok');
  });

  it('falls back to the first step for an unknown step name and says so', () => {
    const result = loadDraft(rawDraft({ currentStep: 'dashboard' }), OWNER, NOW);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.draft.currentStep).toBe('basic');
      expect(result.draft.needsAttention).toContain('currentStep');
    }
  });
});

describe('sanitizeRestoredFields — invalid legacy data', () => {
  it('drops values of the wrong type and names them for review', () => {
    const { formData, needsAttention } = sanitizeRestoredFields({
      title: 'Loft',
      pricePerNight: '120', // string from an older build
      bedrooms: Number.NaN,
      amenities: ['wifi', 42],
      petsAllowed: 'yes',
      maxNights: null,
    });
    expect(formData).toEqual({ title: 'Loft', maxNights: null });
    expect(needsAttention.sort()).toEqual(
      ['amenities', 'bedrooms', 'petsAllowed', 'pricePerNight'].sort()
    );
  });

  it('ignores unknown keys silently', () => {
    const { formData, needsAttention } = sanitizeRestoredFields({ title: 'x', admin: true });
    expect(formData).toEqual({ title: 'x' });
    expect(needsAttention).toEqual([]);
  });
});

describe('summarizeDraft', () => {
  it('states when it was saved and the step reached', () => {
    const text = summarizeDraft(
      {
        formData: {},
        currentStep: 'amenities',
        savedAt: NOW - 3 * 60 * 60 * 1000,
        needsAttention: [],
      },
      NOW
    );
    expect(text).toBe('Saved 3 h ago, on step 3 of 7 (Amenities).');
  });

  it('says "just now" for a draft saved under a minute ago', () => {
    const text = summarizeDraft(
      { formData: {}, currentStep: 'basic', savedAt: NOW - 5_000, needsAttention: [] },
      NOW
    );
    expect(text).toContain('Saved just now');
  });
});

describe('serializeDraft', () => {
  it('writes the schema version and owner into the envelope', () => {
    const parsed = JSON.parse(
      serializeDraft({ ownerKey: OWNER, currentStep: 'basic', formData: {}, now: NOW })
    );
    expect(parsed.schemaVersion).toBe(DRAFT_SCHEMA_VERSION);
    expect(parsed.ownerKey).toBe(OWNER);
    expect(parsed.savedAt).toBe(NOW);
  });
});
