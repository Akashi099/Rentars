# File and Image Upload Security

## Overview

File uploads are a significant attack surface: malware distribution, storage exhaustion, content abuse, and path traversal. This document outlines Rentars' hardened upload validation.

## Upload Flow

```
1. Browser selects file (client-side MIME type check — advisory only)
   ↓
2. Express multer validates file size (`MAX_IMAGE_SIZE_BYTES`, default 5 MB) and file count (1)
   ↓
3. Magic-byte detection (real file type, not just extension)
   ↓
4. Format validation (JPEG, PNG, WebP only)
   ↓
5. Image dimension validation (200-4096px)
   ↓
6. SVG safety scan (no scripts, entities, iframes)
   ↓
7. Re-encode image (strip metadata, normalize format)
   ↓
8. Generate derivatives (thumbnail, small, medium)
   ↓
9. Upload to Supabase Storage with restrictive path
   ↓
10. Return signed URL with 1-hour expiration
```

## Server-Side Validation

### Magic Byte Detection

File type is determined by inspecting the actual file content (magic bytes), not extension or MIME header:

| Format | Magic Bytes | Risk if Not Detected |
|--------|------------|---------------------|
| JPEG | `FF D8 FF` | Binary malware with `.jpg` extension |
| PNG | `89 50 4E 47` | Executable disguised as image |
| WebP | `52 49 46 46` (RIFF) | Script payload in WebP wrapper |
| SVG | `3C 3F 78 6D` (`<?xml`) | JavaScript execution via event handlers |
| ZIP | `50 4B` (PK) | Archive with embedded malware |
| EXE | `4D 5A` (MZ) | Executable file |

### Format Whitelist

Only these formats are accepted after magic-byte validation:
- `image/jpeg` (JPEG)
- `image/png` (PNG)
- `image/webp` (WebP)

Explicitly rejected:
- SVG (unless scanned for unsafe content)
- GIF (no animations allowed)
- BMP, TIFF (rarely needed; increases validation complexity)
- PDF, DOCX, ZIP, EXE, etc. (non-image formats)

### Dimension Validation

After decoding the image, Sharp validates:
- **Minimum**: 200×200 pixels (prevent thumbnails masquerading as full images)
- **Maximum input**: 8192 px on either edge, and at most 40 megapixels decoded
  (`IMAGE_LIMITS` in `apps/backend/src/services/imageValidation.ts`). The pixel cap
  is passed to sharp as `limitInputPixels`, so decompression bombs are refused
  before pixels are allocated. Large phone photos are accepted and downscaled
  rather than rejected.
- **Bounded output**: the main image is at most 1920×1080 and the thumbnail at most
  800×600, both WebP (`optimizeImage` in `apps/backend/src/config/supabase-storage.ts`).

Invalid dimensions are rejected with specific error messages.

### Size Limits

- **File size**: 10 MB maximum (enforced by multer before validation)
- **Total per property**: 10 images × 10 MB = 100 MB soft limit (enforced in property.service.ts)

Exceeding limits returns 413 Payload Too Large.

## SVG Handling

SVG files are dangerous because they can execute JavaScript. If SVG support is required in future:

```javascript
const dangerousPatterns = [
  /<script/i,           // <script> tags
  /javascript:/i,       // javascript: protocol
  /on\w+\s*=/i,        // Event handlers (onclick, onerror, etc.)
  /<iframe/i,          // Frames
  /<object/i,          // Objects
  /<embed/i,           // Embeds
  /<link/i,            // External resources
  /<style/i,           // CSS (can exfiltrate data)
  /<meta/i,            // Metadata injection
  /<!ENTITY/i,         // XXE — XML External Entity
  /SYSTEM/i,           // XXE attack vector
];
```

For now, SVGs are rejected at the format whitelist stage.

### Client-supplied type is advisory

The multipart `Content-Type` and file extension are never trusted. The format is
decided only by `detectImageFormat` on the leading bytes. Processing never falls
back to the original buffer: if the image cannot be decoded or re-encoded, the
upload is refused. Storage paths use a random suffix and a UUID-validated property id.

## Image Re-encoding

All accepted images are re-encoded to normalize format and strip metadata:

```typescript
const normalized = await sharp(buffer)
  .withMetadata()        // Preserve orientation EXIF only
  .toFormat('webp', {
    quality: 85,
    progressive: true,
  })
  .toBuffer();
```

Benefits:
- **Metadata stripping**: EXIF, IPTC, XMP removed (prevents info leakage)
- **Format normalization**: All images stored as WebP (reduces storage, improves compatibility)
- **Quality optimization**: 85% quality is visually lossless; reduces size by 30-50%
- **Progressive encoding**: Images render incrementally; better UX

## Image Derivatives

Three versions are generated for optimal delivery:

| Size | Dimensions | Quality | Use Case |
|------|-----------|---------|----------|
| Thumbnail | 200×200 | 75% | Property list previews |
| Small | 500×500 | 80% | Detail page thumbnails |
| Medium | 1200×1200 | 85% | Full-screen gallery |

Original full-resolution image is never served; users get optimized sizes.

## Storage Path Isolation

Files are stored with ownership-aware paths:

```
properties/{property_id}/user-{user_id}/{timestamp}-{sanitized_name}
```

Example:
```
properties/prop-123/user-abc-def/1695123456789-kitchen-view.webp
```

Benefits:
- **Ownership verification**: Path includes user_id; server checks ownership before deletion/access
- **Namespace isolation**: Even if attacker guesses a path, they can't access another user's files
- **Timestamp uniqueness**: Prevents collisions; enables cleanup
- **Sanitized names**: Removes special characters; reduces injection risks

### Path Traversal Prevention

1. **User ID in path**: Attacker cannot traverse to `../../../other-user/` (path is generated server-side)
2. **No direct filename access**: Client always uses signed URLs; cannot guess paths
3. **Bucket policies**: Supabase Storage bucket policies restrict access by authenticated user

## Signed URLs & Expiration

All file URLs are signed and time-limited:

```typescript
const signedUrl = await supabase.storage
  .from('property-images')
  .createSignedUrl(path, 3600); // 1 hour expiration
```

Benefits:
- **Time-limited**: URLs expire after 1 hour; reduces window for URL sharing
- **Signature verification**: URL is signed by server; client cannot forge or modify expiration
- **No permanent access**: Users must request fresh URLs for downloads after 1 hour

## EXIF & Metadata Security

EXIF data can leak sensitive information:

| Risk | Example | Mitigation |
|------|---------|-----------|
| Location tracking | GPS coordinates | Stripped by Sharp |
| Device fingerprinting | Camera model, serial | Stripped by Sharp |
| Timing attacks | Photo creation date | Stripped; replaced with upload timestamp |
| User PII | Comments, copyright | Stripped completely |

All user-provided metadata is discarded during re-encoding.

## Upload Rate Limiting

Uploads are rate-limited to prevent abuse:

- **Per user**: 100 uploads per hour
- **Per property**: 1 image per 10 seconds (prevents rapid multi-upload attacks)

Exceeded limits return 429 Too Many Requests.

## Virus Scanning (Future Enhancement)

For production, consider integrating ClamAV or VirusTotal:

```typescript
// Pseudo-code for future enhancement
const { virus_detected, scan_id } = await scanWithClamav(buffer);
if (virus_detected) {
  structuredLog({ level: 'warn', message: 'Malware detected', scan_id });
  return res.status(403).json({ error: 'File failed security scan' });
}
```

## Content Moderation (Future Enhancement)

For content abuse (explicit images, spam), integrate:
- Google Vision API
- AWS Rekognition
- Clarifai

Flag suspicious uploads for human review before approval.

## Upload Rejection Scenarios

| Scenario | Status | Response |
|----------|--------|----------|
| File size > 10 MB | 413 | Payload Too Large |
| Invalid magic bytes | 400 | File type not recognized |
| Executable detected | 403 | Executable files not allowed |
| Unsafe SVG content | 403 | SVG contains disallowed content |
| Image < 200×200px | 400 | Image too small |
| Image > 4096×4096px | 400 | Image too large |
| Not an image format | 400 | File type not allowed |
| Corrupted image data | 400 | Unable to process image |
| User not owner of property | 403 | Forbidden |
| Property not found | 404 | Property not found |

## Storage Security

### Bucket Policies

The `property-images` bucket has restrictive policies:

```javascript
CREATE POLICY "Users can view their own images"
ON property_images
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can upload to their namespace"
ON property_images
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own images"
ON property_images
FOR DELETE
USING (auth.uid() = user_id);
```

### Cleanup

Unused images are deleted after 30 days if not linked to a property:

```sql
DELETE FROM property_images
WHERE updated_at < NOW() - INTERVAL '30 days'
  AND property_id IS NULL;
```

## API Endpoints

### Upload Image

```
POST /api/v1/properties/{property_id}/images
Content-Type: multipart/form-data

Multipart body:
- file: binary image data

Response (201 Created):
{
  "id": "img-123",
  "url": "https://storage.rentars.io/...",
  "url_expires_at": "2026-09-25T12:00:00Z",
  "width": 1200,
  "height": 800,
  "size_bytes": 245680,
  "created_at": "2026-09-25T11:00:00Z"
}
```

### Errors

```json
{
  "error": "File exceeds maximum size of 10485760 bytes"
}
```

## Testing

Test files in `__tests__/file-upload-validation.test.ts` cover:
- Magic byte detection for all formats
- Size validation (min/max)
- Dimension validation (min/max)
- SVG payload detection
- Executable file rejection
- Re-encoding to WebP
- Derivative generation
- Path isolation and ownership checks
- Signed URL expiration

Run with: `bun test __tests__/file-upload-validation.test.ts`

## Related Documents

- `SECURITY_ARCHITECTURE.md` — Overall security design
- `THREAT_MODEL.md` — File upload threats and mitigations
