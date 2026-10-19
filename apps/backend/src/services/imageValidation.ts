/**
 * Content-based image validation for uploads (#745).
 *
 * The client-supplied MIME type and file extension are untrusted. The format is
 * decided from the file's leading bytes (magic numbers) only. Anything that is not
 * a JPEG, PNG or WebP signature is rejected, including SVG (which can carry script),
 * GIF, and executables or archives renamed to look like images.
 */

export type DetectedImageFormat = 'jpeg' | 'png' | 'webp';

/** Raised for input the server must refuse. Maps to a 400 at the HTTP layer. */
export class ImageValidationError extends Error {
  readonly name = 'ImageValidationError';
}

export const IMAGE_LIMITS = {
  /** Smallest accepted edge. Prevents icons and placeholders being listed as photos. */
  minDimension: 200,
  /** Largest accepted edge on input. Derivatives are bounded separately. */
  maxDimension: 8192,
  /** Decoded pixel budget. Blocks decompression bombs before the pixels are allocated. */
  maxPixels: 40_000_000,
} as const;

/**
 * Returns the real format of the image, or null when the bytes are not a supported signature.
 */
export function detectImageFormat(buffer: Buffer): DetectedImageFormat | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length >= 8 && pngSignature.every((byte, i) => buffer[i] === byte)) {
    return 'png';
  }

  // RIFF container with a WEBP form type: "RIFF" <size> "WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

/** Checks decoded dimensions against IMAGE_LIMITS. Throws ImageValidationError on violation. */
export function assertDimensionsAllowed(
  width: number | undefined,
  height: number | undefined
): void {
  if (!width || !height) {
    throw new ImageValidationError('Image dimensions could not be determined');
  }
  if (width < IMAGE_LIMITS.minDimension || height < IMAGE_LIMITS.minDimension) {
    throw new ImageValidationError(
      `Image must be at least ${IMAGE_LIMITS.minDimension}x${IMAGE_LIMITS.minDimension} pixels`
    );
  }
  if (width > IMAGE_LIMITS.maxDimension || height > IMAGE_LIMITS.maxDimension) {
    throw new ImageValidationError(
      `Image must be at most ${IMAGE_LIMITS.maxDimension}x${IMAGE_LIMITS.maxDimension} pixels`
    );
  }
  if (width * height > IMAGE_LIMITS.maxPixels) {
    throw new ImageValidationError('Image is too large to process');
  }
}
