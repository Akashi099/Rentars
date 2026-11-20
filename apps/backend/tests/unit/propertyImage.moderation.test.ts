/**
 * Service-level tests for property image upload atomicity (#921) and
 * moderation visibility, transitions and audit (#922).
 *
 * A small chainable fake stands in for Supabase. Each (table, operation) pair has a
 * canned result, and the fake records every filter and mutation for assertions.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

type Result = { data?: unknown; error?: { message: string } | null; count?: number | null };
type Call = { table: string; op: string; filters: unknown[][]; payload?: unknown };

const results: Record<string, Result> = {};
const calls: Call[] = [];

function setResult(key: string, result: Result) {
  results[key] = result;
}

function fakeFrom(table: string) {
  let op = 'select';
  const filters: unknown[][] = [];
  let payload: unknown;
  const builder: Record<string, unknown> = {};
  const chainable =
    (name: string) =>
    (...args: unknown[]) => {
      if (name === 'insert' || name === 'update' || name === 'delete') {
        op = name;
        payload = args[0];
      } else if (name !== 'select') {
        filters.push([name, ...args]);
      }
      return builder;
    };
  for (const name of [
    'select',
    'insert',
    'update',
    'delete',
    'eq',
    'neq',
    'in',
    'order',
    'limit',
  ]) {
    builder[name] = chainable(name);
  }
  const resolve = async (): Promise<Result> => {
    calls.push({ table, op, filters, payload });
    return results[`${table}.${op}`] ?? { data: null, error: null };
  };
  builder.single = resolve;
  builder.then = (onOk: (v: Result) => unknown, onErr?: (e: unknown) => unknown) =>
    resolve().then(onOk, onErr);
  return builder;
}

const mockUpload = mock(async () => ({
  url: 'https://x/storage/v1/object/public/property-images/p/main.webp',
  thumbnailUrl: 'https://x/storage/v1/object/public/property-images/p/thumb.webp',
}));
const mockDeleteStorage = mock(async () => {});
const mockCacheDel = mock(async () => {});

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: fakeFrom, rpc: mock(async () => ({})), storage: {} },
}));
mock.module('../../src/config/supabase-storage.js', () => ({
  uploadImage: mockUpload,
  deleteImage: mockDeleteStorage,
}));
mock.module('../../src/config/env.js', () => ({ env: { MAX_IMAGES_PER_PROPERTY: 10 } }));
mock.module('../../src/services/cache.service.js', () => ({
  get: mock(async () => null),
  set: mock(async () => {}),
  del: mockCacheDel,
}));

const {
  addPropertyImage,
  getPropertyImages,
  getOwnerPropertyImages,
  removePropertyImage,
  reorderPropertyImages,
  setPrimaryImage,
  moderatePropertyImage,
} = await import('../../src/services/propertyImage.service');

const PROPERTY_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-1';
const IMAGE_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = 'admin-1';
const URL_MAIN = 'https://x/storage/v1/object/public/property-images/p/main.webp';
const URL_THUMB = 'https://x/storage/v1/object/public/property-images/p/thumb.webp';
const FILE = {
  buffer: Buffer.from('x'),
  mimetype: 'image/jpeg',
  originalname: 'a.jpg',
} as Express.Multer.File;

function callsFor(table: string, op?: string) {
  return calls.filter((c) => c.table === table && (op === undefined || c.op === op));
}

function hasFilter(call: Call, name: string, ...args: unknown[]) {
  return call.filters.some(
    (f) => f[0] === name && JSON.stringify(f.slice(1)) === JSON.stringify(args)
  );
}

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(results)) delete results[k];
  mockUpload.mockClear();
  mockDeleteStorage.mockClear();
  mockCacheDel.mockClear();
  mockDeleteStorage.mockImplementation(async () => {});
});

describe('addPropertyImage — atomic upload (#921)', () => {
  function primeOwnedProperty() {
    setResult('properties.select', { data: { id: PROPERTY_ID, owner_id: OWNER_ID } });
    setResult('property_images.select', { count: 0, data: null });
  }

  it('removes uploaded storage objects when the record insert fails', async () => {
    primeOwnedProperty();
    setResult('property_images.insert', { data: null, error: { message: 'db down' } });

    const result = await addPropertyImage(PROPERTY_ID, OWNER_ID, FILE);

    expect(result.success).toBe(false);
    expect(result.error).toBe('db down');
    expect(mockDeleteStorage).toHaveBeenCalledWith(URL_MAIN, URL_THUMB);
  });

  it('keeps the upload and reports success when the insert succeeds, without cleanup', async () => {
    primeOwnedProperty();
    setResult('property_images.insert', {
      data: {
        id: IMAGE_ID,
        property_id: PROPERTY_ID,
        url: URL_MAIN,
        is_primary: true,
        display_order: 1,
        moderation_status: 'pending',
      },
      error: null,
    });

    const result = await addPropertyImage(PROPERTY_ID, OWNER_ID, FILE);

    expect(result.success).toBe(true);
    expect(result.data?.moderation_status).toBe('pending');
    expect(mockDeleteStorage).not.toHaveBeenCalled();
  });

  it('does not count rejected or removed images against the upload limit', async () => {
    primeOwnedProperty();
    setResult('property_images.insert', { data: { id: IMAGE_ID }, error: null });

    await addPropertyImage(PROPERTY_ID, OWNER_ID, FILE);

    const countCall = callsFor('property_images', 'select')[0];
    expect(hasFilter(countCall, 'in', 'moderation_status', ['pending', 'approved'])).toBe(true);
  });

  it('refuses a non-owner before uploading anything', async () => {
    setResult('properties.select', { data: { id: PROPERTY_ID, owner_id: 'someone-else' } });

    const result = await addPropertyImage(PROPERTY_ID, OWNER_ID, FILE);

    expect(result.error).toMatch(/Forbidden/);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

describe('removePropertyImage — fail closed (#921)', () => {
  it('keeps the record when storage deletion fails, so the host can retry', async () => {
    setResult('properties.select', { data: { owner_id: OWNER_ID } });
    setResult('property_images.select', {
      data: { url: URL_MAIN, thumbnail_url: URL_THUMB, is_primary: false },
    });
    mockDeleteStorage.mockImplementation(async () => {
      throw new Error('storage unavailable');
    });

    const result = await removePropertyImage(PROPERTY_ID, IMAGE_ID, OWNER_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/retry/);
    expect(callsFor('property_images', 'delete')).toHaveLength(0);
  });
});

describe('reorderPropertyImages (#921)', () => {
  it('rejects a partial list before writing any row', async () => {
    setResult('properties.select', { data: { owner_id: OWNER_ID } });
    setResult('property_images.select', { data: [{ id: 'a' }, { id: 'b' }] });

    const result = await reorderPropertyImages(PROPERTY_ID, OWNER_ID, ['a']);

    expect(result.success).toBe(false);
    expect(callsFor('property_images', 'update')).toHaveLength(0);
  });

  it('writes one display_order per image when the list is a full permutation', async () => {
    setResult('properties.select', { data: { owner_id: OWNER_ID } });
    setResult('property_images.select', { data: [{ id: 'a' }, { id: 'b' }] });
    setResult('property_images.update', { data: null, error: null });

    await reorderPropertyImages(PROPERTY_ID, OWNER_ID, ['b', 'a']);

    expect(callsFor('property_images', 'update')).toHaveLength(2);
  });
});

describe('public and owner image visibility (#922)', () => {
  it('public listing only asks for approved images', async () => {
    setResult('property_images.select', { data: [] });

    await getPropertyImages(PROPERTY_ID);

    expect(
      hasFilter(callsFor('property_images', 'select')[0], 'eq', 'moderation_status', 'approved')
    ).toBe(true);
  });

  it('owner listing excludes removed images and is refused to non-owners', async () => {
    setResult('properties.select', { data: { owner_id: 'someone-else' } });
    const denied = await getOwnerPropertyImages(PROPERTY_ID, OWNER_ID);
    expect(denied.error).toMatch(/Forbidden/);

    setResult('properties.select', { data: { owner_id: OWNER_ID } });
    setResult('property_images.select', { data: [] });
    await getOwnerPropertyImages(PROPERTY_ID, OWNER_ID);
    const listCall = callsFor('property_images', 'select').at(-1)!;
    expect(hasFilter(listCall, 'neq', 'moderation_status', 'removed')).toBe(true);
  });

  it('refuses to make a pending image primary', async () => {
    setResult('properties.select', { data: { owner_id: OWNER_ID } });
    setResult('property_images.select', { data: { id: IMAGE_ID, moderation_status: 'pending' } });

    const result = await setPrimaryImage(PROPERTY_ID, IMAGE_ID, OWNER_ID);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(callsFor('property_images', 'update')).toHaveLength(0);
  });
});

describe('moderatePropertyImage (#922)', () => {
  function primeImage(status: string, extra: Record<string, unknown> = {}) {
    setResult('property_images.select', {
      data: {
        id: IMAGE_ID,
        property_id: PROPERTY_ID,
        url: URL_MAIN,
        thumbnail_url: URL_THUMB,
        is_primary: false,
        display_order: 1,
        moderation_status: status,
        ...extra,
      },
    });
    setResult('property_images.update', {
      data: { id: IMAGE_ID, property_id: PROPERTY_ID, moderation_status: 'updated' },
      error: null,
    });
    setResult('property_image_moderation_events.insert', { data: null, error: null });
  }

  it('approves a pending image, writes an audit event and invalidates the cached property', async () => {
    primeImage('pending');

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'approved',
    });

    expect(result.success).toBe(true);
    const update = callsFor('property_images', 'update')[0];
    expect(update.payload).toMatchObject({
      moderation_status: 'approved',
      moderated_by: ADMIN_ID,
      moderation_reason: null,
    });
    expect(hasFilter(update, 'eq', 'moderation_status', 'pending')).toBe(true);
    const audit = callsFor('property_image_moderation_events', 'insert')[0];
    expect(audit.payload).toMatchObject({
      image_id: IMAGE_ID,
      from_status: 'pending',
      to_status: 'approved',
      actor_id: ADMIN_ID,
    });
    expect(mockCacheDel).toHaveBeenCalledWith(`property:${PROPERTY_ID}`);
  });

  it('never moves a removed image back to approved', async () => {
    primeImage('removed');

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(callsFor('property_images', 'update')).toHaveLength(0);
  });

  it('requires a reason to reject and makes no database call without one', async () => {
    primeImage('pending');

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'rejected',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejecting stores the reason, deletes the bytes from storage and clears primary', async () => {
    primeImage('approved', { is_primary: true });

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'rejected',
      reason: '  Contains a person  ',
    });

    expect(result.success).toBe(true);
    const update = callsFor('property_images', 'update')[0];
    expect(update.payload).toMatchObject({
      moderation_status: 'rejected',
      moderation_reason: 'Contains a person',
      is_primary: false,
    });
    expect(mockDeleteStorage).toHaveBeenCalledWith(URL_MAIN, URL_THUMB);
  });

  it('returns a conflict when a concurrent moderator changed the status first', async () => {
    primeImage('pending');
    setResult('property_images.update', { data: null, error: { message: 'no rows' } });

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(409);
    expect(callsFor('property_image_moderation_events', 'insert')).toHaveLength(0);
  });

  it('reports failure when the moderation applied but the audit record did not', async () => {
    primeImage('pending');
    setResult('property_image_moderation_events.insert', {
      data: null,
      error: { message: 'audit down' },
    });

    const result = await moderatePropertyImage({
      propertyId: PROPERTY_ID,
      imageId: IMAGE_ID,
      actorId: ADMIN_ID,
      decision: 'approved',
    });

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(500);
  });
});
