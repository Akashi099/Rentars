import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';
import {
  ImageValidationError,
  IMAGE_LIMITS,
  assertDimensionsAllowed,
  detectImageFormat,
} from '../services/imageValidation.js';

export const STORAGE_BUCKET = 'property-images';

interface MulterFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

type Sharp = typeof import('sharp');
let sharpLib: Sharp | null = null;

async function getSharp(): Promise<Sharp | null> {
  if (sharpLib !== null) return sharpLib;
  try {
    // The CJS module exposes the callable as `default`; the namespace object is not callable.
    sharpLib = (await import('sharp')).default as unknown as Sharp;
    return sharpLib;
  } catch {
    return null;
  }
}

export interface OptimizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

/**
 * Decodes, validates and re-encodes an image to WebP.
 *
 * - The format is decided from the bytes, never from `_mimetype` or the filename.
 * - Dimensions and decoded pixel count are checked before any pixels are processed.
 * - Re-encoding strips EXIF/GPS/XMP metadata and any non-pixel payload.
 *
 * Never falls back to the original buffer: storing unprocessed bytes would bypass
 * every check above.
 */
export async function optimizeImage(
  buffer: Buffer,
  _mimetype: string,
  options: OptimizeOptions = {}
): Promise<{ buffer: Buffer; mimetype: string }> {
  const { maxWidth = 1920, maxHeight = 1080, quality = 80 } = options;

  if (!detectImageFormat(buffer)) {
    throw new ImageValidationError('File is not a supported image (JPEG, PNG or WebP)');
  }

  const sharp = await getSharp();
  if (!sharp) {
    throw new Error('Image processing is unavailable');
  }

  const sharpOptions = { limitInputPixels: IMAGE_LIMITS.maxPixels };

  let metadata: { width?: number; height?: number };
  try {
    metadata = await (sharp as any)(buffer, sharpOptions).metadata();
  } catch {
    throw new ImageValidationError('Image could not be decoded');
  }
  assertDimensionsAllowed(metadata.width, metadata.height);

  let optimized: Buffer;
  try {
    optimized = await (sharp as any)(buffer, sharpOptions)
      .rotate()
      .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
  } catch {
    throw new ImageValidationError('Image could not be decoded');
  }

  return { buffer: optimized, mimetype: 'image/webp' };
}

/**
 * Extracts the storage file path from a Supabase public URL.
 * URL format: .../object/public/<bucket>/<path>
 */
function extractStoragePath(imageUrl: string): string {
  const marker = `/${STORAGE_BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) throw new Error(`Invalid image URL: cannot resolve storage path`);
  return imageUrl.slice(idx + marker.length);
}

export async function uploadImage(
  propertyId: string,
  file: MulterFile,
): Promise<{ url: string; thumbnailUrl: string }> {
  const timestamp = Date.now();
  // A random suffix keeps two uploads in the same millisecond from colliding.
  const uniqueId = randomUUID();
  const safeBaseName = file.originalname.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';

  // Both variants are re-encoded from the validated bytes. Output is always WebP.
  const { buffer: mainBuffer, mimetype: mainMime } = await optimizeImage(
    file.buffer,
    file.mimetype,
    { maxWidth: 1920, maxHeight: 1080, quality: 80 }
  );

  const { buffer: thumbBuffer, mimetype: thumbMime } = await optimizeImage(
    file.buffer,
    file.mimetype,
    { maxWidth: 800, maxHeight: 600, quality: 80 }
  );

  const mainExt = mainMime === 'image/webp' ? 'webp' : 'jpg';
  const thumbExt = thumbMime === 'image/webp' ? 'webp' : 'jpg';

  const mainFileName = `${propertyId}/${timestamp}-${uniqueId}-${safeBaseName}.${mainExt}`;
  const thumbFileName = `${propertyId}/thumb_${timestamp}-${uniqueId}-${safeBaseName}.${thumbExt}`;

  const { error: mainError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(mainFileName, mainBuffer, {
      contentType: mainMime,
    });

  if (mainError) {
    throw new Error(`Failed to upload image: ${mainError.message}`);
  }

  const { error: thumbError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(thumbFileName, thumbBuffer, {
      contentType: thumbMime,
    });

  if (thumbError) {
    // Do not leave the main image orphaned in storage with no database row.
    await supabase.storage.from(STORAGE_BUCKET).remove([mainFileName]);
    throw new Error(`Failed to upload thumbnail: ${thumbError.message}`);
  }

  const { data: mainData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(mainFileName);
  const { data: thumbData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(thumbFileName);

  return {
    url: mainData.publicUrl,
    thumbnailUrl: thumbData.publicUrl,
  };
}

export async function deleteImage(imageUrl: string, thumbnailUrl?: string | null): Promise<void> {
  const pathsToDelete: string[] = [extractStoragePath(imageUrl)];

  if (thumbnailUrl) {
    try {
      pathsToDelete.push(extractStoragePath(thumbnailUrl));
    } catch {
      // Ignore if thumbnail storage path extraction fails
    }
  }

  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(pathsToDelete);

  if (error) {
    throw new Error(`Failed to delete image: ${error.message}`);
  }
}
