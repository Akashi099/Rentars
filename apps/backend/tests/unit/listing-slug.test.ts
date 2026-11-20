/**
 * #924: property slug generation and stability.
 *
 * Covers deterministic generation (accents, punctuation, non-Latin text, empty
 * titles), collision-safe creation (retry on the unique index, no silent
 * slug-less rows), and the rule that editing a title never moves an old URL to a
 * different listing.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateSlug } from '../../src/utils/slug.js';
import {
  type FakeSupabase,
  createFakeSupabase,
  currentFakeSupabase,
  useFakeSupabase,
} from './helpers/fakeSupabase';

const cacheDeleted: string[] = [];
mock.module('../../src/services/cache.service.js', () => ({
  get: async () => null,
  set: async () => undefined,
  del: async (key: string) => {
    cacheDeleted.push(key);
  },
  invalidatePattern: async () => undefined,
}));

mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (table: string) => currentFakeSupabase().from(table),
  },
}));

// Isolated instance: see listing-availability.test.ts for why.
const { createProperty, updateProperty, getPropertyBySlug } = await import(
  '../../src/services/property.service.ts?slug-spec'
);

const ID_A = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const ID_B = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

function install(f: FakeSupabase): FakeSupabase {
  useFakeSupabase(f);
  return f;
}

// ─── Generation ───────────────────────────────────────────────────────────────

describe('generateSlug — normalisation', () => {
  it('folds accents to their base letters', () => {
    expect(generateSlug('Café Loft', 'Paris', ID_A)).toBe('cafe-loft-paris-a1b2c3');
    expect(generateSlug('Casa Señorial', 'São Paulo', ID_A)).toBe('casa-senorial-sao-paulo-a1b2c3');
  });

  it('collapses punctuation and symbols into single hyphens', () => {
    expect(generateSlug("Rock 'n' Roll — Loft!!", 'Berlin', ID_A)).toBe(
      'rock-n-roll-loft-berlin-a1b2c3'
    );
  });

  it('uses "property" as the base for titles with no Latin letters, keeping the id suffix', () => {
    expect(generateSlug('東京の部屋', 'Tokyo', ID_A)).toBe('property-tokyo-a1b2c3');
    expect(generateSlug('東京の部屋', undefined, ID_A)).toBe('property-a1b2c3');
  });

  it('never produces a slug that starts with the id suffix', () => {
    const slug = generateSlug('ロフト', null, ID_A);
    expect(slug.startsWith('-')).toBe(false);
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('is deterministic for the same title, city and id', () => {
    expect(generateSlug('Café Loft', 'Paris', ID_A)).toBe(generateSlug('Café Loft', 'Paris', ID_A));
  });

  it('gives different ids different slugs for the same title', () => {
    expect(generateSlug('Beach House', 'Miami', ID_A)).not.toBe(
      generateSlug('Beach House', 'Miami', ID_B)
    );
  });
});

// ─── Creation ─────────────────────────────────────────────────────────────────

/** Make the first `failures` inserts into `properties` fail with `error`. */
function failInserts(
  fake: FakeSupabase,
  failures: number,
  error: { code?: string; message: string }
) {
  const original = fake.from;
  let remaining = failures;
  fake.from = ((table: string) => {
    const builder = original(table) as Record<string, unknown>;
    if (table !== 'properties') return builder;
    const originalInsert = builder.insert as (v: Record<string, unknown>) => unknown;
    builder.insert = (values: Record<string, unknown>) => {
      if (remaining > 0) {
        remaining--;
        const failing: Record<string, unknown> = {};
        failing.select = () => failing;
        failing.single = async () => ({ data: null, error });
        return failing;
      }
      return originalInsert(values);
    };
    return builder;
  }) as FakeSupabase['from'];
  return () => failures - remaining;
}

describe('createProperty — slug at insert', () => {
  beforeEach(() => {
    cacheDeleted.length = 0;
  });

  it('writes the row once, with a slug derived from its own id', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    const result = await createProperty({ title: 'Cozy Loft', city: 'Paris' });

    expect(result.success).toBe(true);
    expect(fake.tables.properties).toHaveLength(1);
    const row = fake.tables.properties[0];
    expect(row.slug).toBe(generateSlug('Cozy Loft', 'Paris', String(row.id)));
    expect(result.data?.slug).toBe(row.slug);
  });

  it('ignores a client-supplied slug', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    await createProperty({ title: 'Cozy Loft', city: 'Paris', slug: 'hijacked' } as never);
    expect(fake.tables.properties[0].slug).not.toBe('hijacked');
  });

  it('draws a fresh id and retries when the slug collides on the unique index', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    const attempts = failInserts(fake, 1, { code: '23505', message: 'duplicate key value' });

    const result = await createProperty({ title: 'Cozy Loft', city: 'Paris' });

    expect(result.success).toBe(true);
    expect(attempts()).toBe(1);
    const row = fake.tables.properties[0];
    expect(row.slug).toBe(generateSlug('Cozy Loft', 'Paris', String(row.id)));
  });

  it('gives up after the retry budget and returns an error, never a slug-less row', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    failInserts(fake, 10, { code: '23505', message: 'duplicate key value' });

    const result = await createProperty({ title: 'Cozy Loft', city: 'Paris' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/duplicate key/);
    expect(fake.tables.properties).toHaveLength(0);
  });

  it('does not retry a non-collision database error', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    const attempts = failInserts(fake, 10, { message: 'connection reset' });

    const result = await createProperty({ title: 'Cozy Loft', city: 'Paris' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection reset');
    expect(attempts()).toBe(1);
  });

  it('rejects a title with no letters or digits', async () => {
    const fake = install(createFakeSupabase({ properties: [] }));
    const result = await createProperty({ title: '!!!---...' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/letter or digit/i);
    expect(fake.log).toHaveLength(0);
  });

  it('accepts a non-Latin title', async () => {
    install(createFakeSupabase({ properties: [] }));
    const result = await createProperty({ title: '東京の部屋', city: 'Tokyo' });
    expect(result.success).toBe(true);
    expect(result.data?.slug).toMatch(/^property-tokyo-[a-z0-9]{6}$/);
  });
});

// ─── Stability after creation ─────────────────────────────────────────────────

describe('updateProperty — slugs are stable', () => {
  beforeEach(() => {
    cacheDeleted.length = 0;
  });

  it('keeps the slug when the title changes, and an old URL still resolves to the same listing', async () => {
    const original = generateSlug('Cozy Loft', 'Paris', ID_A);
    const fake = install(
      createFakeSupabase({
        properties: [
          {
            id: ID_A,
            owner_id: 'owner-1',
            title: 'Cozy Loft',
            city: 'Paris',
            slug: original,
            status: 'available',
            draft_status: null,
            moderation_state: 'visible',
            deleted_at: null,
          },
        ],
      })
    );

    const edit = await updateProperty(ID_A, { title: 'Sunny Penthouse' } as never);
    expect(edit.success).toBe(true);
    expect(fake.tables.properties[0].slug).toBe(original);

    const resolved = await getPropertyBySlug(original);
    expect(resolved.success).toBe(true);
    expect(resolved.data?.id).toBe(ID_A);
  });

  it('ignores a client-supplied slug on update', async () => {
    const original = generateSlug('Cozy Loft', 'Paris', ID_A);
    const fake = install(
      createFakeSupabase({
        properties: [{ id: ID_A, owner_id: 'owner-1', title: 'Cozy Loft', slug: original }],
      })
    );

    const result = await updateProperty(ID_A, { slug: 'taken-by-someone-else' } as never);
    expect(result.success).toBe(true);
    expect(fake.tables.properties[0].slug).toBe(original);
  });
});
