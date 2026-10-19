import { describe, it, expect, beforeEach, mock } from 'bun:test';
import sharp from 'sharp';

// ── Supabase + storage fake ───────────────────────────────────────────────────

type Op = { method: string; args: unknown[] };
type Result = { data: unknown; error: unknown };
type Handler = (table: string, ops: Op[]) => Result;

const fake: {
  handler: Handler;
  uploads: Array<{ path: string; size: number }>;
  removed: string[][];
  uploadError: unknown;
  thumbFailsAfter: number;
} = {
  handler: () => ({ data: null, error: null }),
  uploads: [],
  removed: [],
  uploadError: null,
  thumbFailsAfter: Number.POSITIVE_INFINITY,
};

function builder(table: string): Record<string, unknown> {
  const ops: Op[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      ops.push({ method, args });
      return chain;
    };
  }
  chain.single = () => fake.handler(table, ops);
  chain.maybeSingle = () => fake.handler(table, ops);
  // biome-ignore lint/suspicious/noThenProperty: the builder is awaited like a Supabase query
  chain.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(fake.handler(table, ops)).then(resolve, reject);
  return chain;
}

let uploadCount = 0;
const storageBucket = {
  upload: async (path: string, body: Buffer) => {
    uploadCount += 1;
    if (uploadCount > fake.thumbFailsAfter) {
      return { data: null, error: { message: 'storage unavailable' } };
    }
    fake.uploads.push({ path, size: body.length });
    return { data: { path }, error: fake.uploadError };
  },
  remove: async (paths: string[]) => {
    fake.removed.push(paths);
    return { data: null, error: null };
  },
  getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
};

mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    from: (table: string) => builder(table),
    storage: { from: () => storageBucket },
  },
}));

mock.module('../../src/config/env.js', () => ({
  env: { MAX_IMAGES_PER_PROPERTY: 10, MAX_IMAGE_SIZE_BYTES: 5242880 },
}));

mock.module('../../src/services/cache.service.js', () => ({
  del: async () => true,
  get: async () => null,
  set: async () => true,
}));

const storage = await import('../../src/config/supabase-storage.js');
const { detectImageFormat, IMAGE_LIMITS, ImageValidationError } = await import(
  '../../src/services/imageValidation.js'
);
const imageService = await import('../../src/services/propertyImage.service.js');

const OWNER = '11111111-1111-4111-8111-111111111111';
const PROPERTY = '33333333-3333-4333-8333-333333333333';
const OTHER_PROPERTY = '44444444-4444-4444-8444-444444444444';

async function jpegBuffer(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#3a7' } })
    .jpeg()
    .toBuffer();
}

function fileFrom(buffer: Buffer, mimetype: string, originalname = 'photo.jpg') {
  return { buffer, mimetype, originalname } as Express.Multer.File;
}

beforeEach(() => {
  fake.handler = () => ({ data: null, error: null });
  fake.uploads = [];
  fake.removed = [];
  fake.thumbFailsAfter = Number.POSITIVE_INFINITY;
  uploadCount = 0;
});

// ── Magic-byte detection ──────────────────────────────────────────────────────

describe('detectImageFormat', () => {
  it('recognises real JPEG, PNG and WebP content', async () => {
    const jpeg = await jpegBuffer(300, 300);
    const png = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const webp = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#000' },
    })
      .webp()
      .toBuffer();

    expect(detectImageFormat(jpeg)).toBe('jpeg');
    expect(detectImageFormat(png)).toBe('png');
    expect(detectImageFormat(webp)).toBe('webp');
  });

  it('rejects SVG, GIF, executables and archives regardless of claimed type', () => {
    const samples = [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      Buffer.from('<?xml version="1.0"?><svg onload="x()"/>'),
      Buffer.from('GIF89a\x01\x00\x01\x00'),
      Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      Buffer.from('PK\x03\x04\x14\x00'),
      Buffer.from('<?php system($_GET["c"]); ?>'),
    ];

    for (const sample of samples) {
      expect(detectImageFormat(sample)).toBeNull();
    }
  });

  it('accepts a PNG signature; decoding is checked separately in optimizeImage', () => {
    // Signature alone is necessary, not sufficient: decoding is checked in optimizeImage.
    const spoof = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('<script>'),
    ]);
    expect(detectImageFormat(spoof)).toBe('png');
  });
});

// ── Re-encoding and bounds ────────────────────────────────────────────────────

describe('optimizeImage', () => {
  it('rejects SVG bytes even when the client claims image/jpeg', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );

    await expect(storage.optimizeImage(svg, 'image/jpeg')).rejects.toBeInstanceOf(
      ImageValidationError
    );
  });

  it('rejects a signature followed by undecodable data', async () => {
    const spoof = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('garbage'),
    ]);

    await expect(storage.optimizeImage(spoof, 'image/png')).rejects.toBeInstanceOf(
      ImageValidationError
    );
  });

  it('rejects images below the minimum dimension', async () => {
    const tiny = await jpegBuffer(120, 120);

    await expect(storage.optimizeImage(tiny, 'image/jpeg')).rejects.toThrow(
      `at least ${IMAGE_LIMITS.minDimension}x${IMAGE_LIMITS.minDimension}`
    );
  });

  it('rejects images above the maximum dimension', async () => {
    const huge = await sharp({
      create: {
        width: IMAGE_LIMITS.maxDimension + 1,
        height: 220,
        channels: 3,
        background: '#000',
      },
    })
      .jpeg()
      .toBuffer();

    await expect(storage.optimizeImage(huge, 'image/jpeg')).rejects.toBeInstanceOf(
      ImageValidationError
    );
  });

  it('outputs WebP with bounded main and thumbnail dimensions', async () => {
    const source = await jpegBuffer(3000, 2000);

    const main = await storage.optimizeImage(source, 'image/jpeg', {
      maxWidth: 1920,
      maxHeight: 1080,
      quality: 80,
    });
    const thumb = await storage.optimizeImage(source, 'image/jpeg', {
      maxWidth: 800,
      maxHeight: 600,
      quality: 80,
    });

    expect(main.mimetype).toBe('image/webp');
    expect(detectImageFormat(main.buffer)).toBe('webp');
    const mainMeta = await sharp(main.buffer).metadata();
    expect(mainMeta.width).toBeLessThanOrEqual(1920);
    expect(mainMeta.height).toBeLessThanOrEqual(1080);

    const thumbMeta = await sharp(thumb.buffer).metadata();
    expect(thumbMeta.width).toBeLessThanOrEqual(800);
    expect(thumbMeta.height).toBeLessThanOrEqual(600);
  });
});

// ── Storage wiring ────────────────────────────────────────────────────────────

describe('uploadImage', () => {
  it('stores paths that include a unique id and never the client file name verbatim', async () => {
    const source = await jpegBuffer(500, 500);

    await storage.uploadImage(PROPERTY, fileFrom(source, 'image/jpeg', '../../etc/passwd.jpg'));

    const [main, thumb] = fake.uploads;
    expect(main.path.startsWith(`${PROPERTY}/`)).toBe(true);
    expect(main.path).not.toContain('..');
    expect(main.path.endsWith('.webp')).toBe(true);
    expect(thumb.path.startsWith(`${PROPERTY}/thumb_`)).toBe(true);
  });

  it('removes the already-uploaded main image when the thumbnail upload fails', async () => {
    const source = await jpegBuffer(500, 500);
    fake.thumbFailsAfter = 1;

    await expect(storage.uploadImage(PROPERTY, fileFrom(source, 'image/jpeg'))).rejects.toThrow(
      'thumbnail'
    );

    expect(fake.removed).toHaveLength(1);
    expect(fake.removed[0][0]).toBe(fake.uploads[0].path);
  });
});

// ── Service-level validation and ownership ────────────────────────────────────

describe('addPropertyImage', () => {
  it('rejects non-image content before anything is stored', async () => {
    fake.handler = (table) =>
      table === 'properties'
        ? { data: { id: PROPERTY, owner_id: OWNER }, error: null }
        : { data: [], error: null };
    const svg = Buffer.from('<svg><script>alert(1)</script></svg>');

    const result = await imageService.addPropertyImage(
      PROPERTY,
      OWNER,
      fileFrom(svg, 'image/svg+xml', 'x.svg')
    );

    expect(result.success).toBe(false);
    expect(fake.uploads).toHaveLength(0);
  });

  it('refuses a property id that is not a plain UUID (no path injection)', async () => {
    const jpeg = await jpegBuffer(400, 400);

    const result = await imageService.addPropertyImage(
      '../other',
      OWNER,
      fileFrom(jpeg, 'image/jpeg')
    );

    expect(result.success).toBe(false);
    expect(fake.uploads).toHaveLength(0);
  });

  it('refuses a user who does not own the property', async () => {
    fake.handler = (table) =>
      table === 'properties'
        ? { data: { id: PROPERTY, owner_id: 'someone-else' }, error: null }
        : { data: [], error: null };
    const jpeg = await jpegBuffer(400, 400);

    const result = await imageService.addPropertyImage(
      PROPERTY,
      OWNER,
      fileFrom(jpeg, 'image/jpeg')
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Forbidden');
    expect(fake.uploads).toHaveLength(0);
  });
});

describe('cross-property identifier tampering', () => {
  it('cannot delete an image that belongs to a different property', async () => {
    fake.handler = (table, ops) => {
      if (table === 'properties') return { data: { owner_id: OWNER }, error: null };
      // The image lookup is scoped by property_id, so a foreign image id returns nothing.
      const scopedToOther = ops.some(
        (o) => o.method === 'eq' && o.args[0] === 'property_id' && o.args[1] === OTHER_PROPERTY
      );
      if (
        table === 'property_images' &&
        ops.some((o) => o.method === 'eq' && o.args[0] === 'property_id' && o.args[1] === PROPERTY)
      ) {
        return scopedToOther
          ? { data: null, error: null }
          : { data: null, error: { message: 'not found' } };
      }
      return { data: null, error: null };
    };

    const result = await imageService.removePropertyImage(PROPERTY, 'foreign-image-id', OWNER);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Image not found');
    expect(fake.removed).toHaveLength(0);
  });

  it('does not clear the current primary when the target image is not in this property', async () => {
    const writes: string[] = [];
    fake.handler = (table, ops) => {
      if (table === 'properties') return { data: { owner_id: OWNER }, error: null };
      if (ops.some((o) => o.method === 'update')) writes.push(table);
      return { data: null, error: { message: 'not found' } };
    };

    const result = await imageService.setPrimaryImage(PROPERTY, 'foreign-image-id', OWNER);

    expect(result.success).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
