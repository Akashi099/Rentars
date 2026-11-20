import { env } from '@/config/env.js';
import { deleteImage as deleteStorageImage, uploadImage } from '@/config/supabase-storage.js';
import { supabase } from '@/config/supabase.js';
import * as cache from './cache.service.js';
import {
  type ImageModerationDecision,
  type ImageModerationStatus,
  canTransitionImageStatus,
  validateModerationInput,
  validateReorderIds,
} from './imageModeration.js';
import { ImageValidationError } from './imageValidation.js';
import type { ServiceResponse } from './index.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PropertyImage {
  id: string;
  property_id: string;
  url: string;
  thumbnail_url?: string | null;
  is_primary: boolean;
  display_order: number;
  moderation_status?: ImageModerationStatus;
  moderation_reason?: string | null;
  created_at?: string;
}

/** Public projection: never includes moderation internals or unapproved images. */
export type PublicPropertyImage = Pick<
  PropertyImage,
  'id' | 'url' | 'is_primary' | 'display_order'
>;

const PUBLIC_IMAGE_COLUMNS = 'id, url, is_primary, display_order';
const OWNER_IMAGE_COLUMNS =
  'id, property_id, url, thumbnail_url, is_primary, display_order, moderation_status, moderation_reason, created_at';

/** Evicts every cached representation of a property, so image changes are visible at once. */
async function invalidatePropertyCache(propertyId: string): Promise<void> {
  await cache.del(`property:${propertyId}`);
}

/** Best-effort removal of storage objects. Logged, never thrown, for compensating paths. */
async function cleanupStorageObjects(url: string, thumbnailUrl?: string | null): Promise<void> {
  try {
    await deleteStorageImage(url, thumbnailUrl);
  } catch (err) {
    console.error('[propertyImage] storage cleanup failed; object may be orphaned', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function assertOwner(propertyId: string, ownerId: string): Promise<ServiceResponse<true>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }
  return { success: true, data: true };
}

/**
 * Upload a new image for a property and store its record.
 *
 * The file is written to storage first, then the record is inserted. If the insert
 * fails the storage objects are removed, so a failed request never leaves an
 * unreferenced file behind. The record starts as `pending` and is not public until a
 * moderator approves it.
 *
 * @param propertyId - UUID of the property
 * @param ownerId - UUID of the requesting user (must be property owner)
 * @param file - Multer file object
 * @returns The created PropertyImage record
 */
export async function addPropertyImage(
  propertyId: string,
  ownerId: string,
  file: Express.Multer.File
): Promise<ServiceResponse<PropertyImage>> {
  // The property id becomes part of the storage path, so it must be a plain UUID.
  if (!UUID_PATTERN.test(propertyId)) return { success: false, error: 'Property not found' };

  // Verify ownership
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('id, owner_id')
    .eq('id', propertyId)
    .single();

  if (propError || !property) return { success: false, error: 'Property not found' };
  if ((property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  // Count existing images BEFORE uploading to storage. Rejected and removed images
  // do not count toward the limit, so a host can replace a rejected photo.
  const { count, error: countError } = await supabase
    .from('property_images')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId)
    .in('moderation_status', ['pending', 'approved']);

  if (countError) return { success: false, error: countError.message };

  const currentCount = count ?? 0;
  if (currentCount >= env.MAX_IMAGES_PER_PROPERTY) {
    return {
      success: false,
      error: `Maximum image limit reached for property (${currentCount}/${env.MAX_IMAGES_PER_PROPERTY})`,
    };
  }

  // Upload main image and thumbnail variant to storage. Content that is not a
  // valid image is rejected here, before anything reaches storage.
  let url: string;
  let thumbnailUrl: string;
  try {
    ({ url, thumbnailUrl } = await uploadImage(propertyId, file));
  } catch (err) {
    if (err instanceof ImageValidationError) return { success: false, error: err.message };
    throw err;
  }

  const displayOrder = currentCount + 1;
  const isPrimary = displayOrder === 1;

  const { data, error } = await supabase
    .from('property_images')
    .insert({
      property_id: propertyId,
      url,
      thumbnail_url: thumbnailUrl,
      is_primary: isPrimary,
      display_order: displayOrder,
    })
    .select(OWNER_IMAGE_COLUMNS)
    .single();

  if (error) {
    // Compensating cleanup: the record was not written, so the uploaded objects are unreferenced.
    await cleanupStorageObjects(url, thumbnailUrl);
    return { success: false, error: error.message };
  }

  // The new image is pending, so the public detail view does not change yet. Invalidate anyway.
  await invalidatePropertyCache(propertyId);

  return { success: true, data: data as PropertyImage };
}

/**
 * List images for the public. Only approved images are returned.
 *
 * @param propertyId - UUID of the property
 */
export async function getPropertyImages(
  propertyId: string
): Promise<ServiceResponse<PublicPropertyImage[]>> {
  const { data, error } = await supabase
    .from('property_images')
    .select(PUBLIC_IMAGE_COLUMNS)
    .eq('property_id', propertyId)
    .eq('moderation_status', 'approved')
    .order('display_order', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PublicPropertyImage[] };
}

/**
 * List every image the owner may see, including pending and rejected images with the
 * moderation reason, so the host can correct a rejected upload. Removed images are excluded.
 *
 * @param propertyId - UUID of the property
 * @param ownerId - UUID of the requesting user (must be property owner)
 */
export async function getOwnerPropertyImages(
  propertyId: string,
  ownerId: string
): Promise<ServiceResponse<PropertyImage[]>> {
  const ownership = await assertOwner(propertyId, ownerId);
  if (!ownership.success) return { success: false, error: ownership.error };

  const { data, error } = await supabase
    .from('property_images')
    .select(OWNER_IMAGE_COLUMNS)
    .eq('property_id', propertyId)
    .neq('moderation_status', 'removed')
    .order('display_order', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PropertyImage[] };
}

/**
 * Delete a property image from storage and the database.
 *
 * Storage is removed first. If that fails the record is kept, so the host can retry
 * and the database never points at a file that was not removed.
 *
 * @param propertyId - UUID of the property
 * @param imageId - UUID of the image record
 * @param ownerId - UUID of the requesting user
 */
export async function removePropertyImage(
  propertyId: string,
  imageId: string,
  ownerId: string
): Promise<ServiceResponse<void>> {
  const ownership = await assertOwner(propertyId, ownerId);
  if (!ownership.success) return { success: false, error: ownership.error };

  const { data: image, error: imgError } = await supabase
    .from('property_images')
    .select('url, thumbnail_url, is_primary')
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .single();

  if (imgError || !image) return { success: false, error: 'Image not found' };

  try {
    await deleteStorageImage((image as PropertyImage).url, (image as PropertyImage).thumbnail_url);
  } catch (err) {
    return {
      success: false,
      error: `Could not delete image, please retry: ${err instanceof Error ? err.message : 'storage error'}`,
    };
  }

  const { error } = await supabase.from('property_images').delete().eq('id', imageId);
  if (error) return { success: false, error: error.message };

  await invalidatePropertyCache(propertyId);

  // If deleted image was primary, promote the next approved one
  if ((image as PropertyImage).is_primary) {
    const { data: next } = await supabase
      .from('property_images')
      .select('id')
      .eq('property_id', propertyId)
      .eq('moderation_status', 'approved')
      .order('display_order', { ascending: true })
      .limit(1)
      .single();

    if (next) {
      await supabase
        .from('property_images')
        .update({ is_primary: true })
        .eq('id', (next as { id: string }).id);
    }
  }

  return { success: true };
}

/**
 * Reorder images for a property by providing a full ordered list of image IDs.
 * The list must name every image of the property exactly once. A partial or foreign
 * list is rejected before any row is written.
 *
 * @param propertyId - UUID of the property
 * @param ownerId - UUID of the requesting user
 * @param orderedIds - Image IDs in the new desired order
 */
export async function reorderPropertyImages(
  propertyId: string,
  ownerId: string,
  orderedIds: string[]
): Promise<ServiceResponse<PropertyImage[]>> {
  const ownership = await assertOwner(propertyId, ownerId);
  if (!ownership.success) return { success: false, error: ownership.error };

  const { data: existing, error: existingError } = await supabase
    .from('property_images')
    .select('id')
    .eq('property_id', propertyId)
    .neq('moderation_status', 'removed');

  if (existingError) return { success: false, error: existingError.message };

  const existingIds = ((existing ?? []) as { id: string }[]).map((row) => row.id);
  const validationError = validateReorderIds(existingIds, orderedIds);
  if (validationError) return { success: false, error: validationError };

  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase
        .from('property_images')
        .update({ display_order: index + 1 })
        .eq('id', id)
        .eq('property_id', propertyId)
    )
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) return { success: false, error: failed.error.message };

  await invalidatePropertyCache(propertyId);

  return getOwnerPropertyImages(propertyId, ownerId);
}

/**
 * Set an image as the primary image for a property. Only approved images can be primary,
 * because the primary image is what the public sees first.
 *
 * @param propertyId - UUID of the property
 * @param imageId - UUID of the image to promote
 * @param ownerId - UUID of the requesting user
 */
export async function setPrimaryImage(
  propertyId: string,
  imageId: string,
  ownerId: string
): Promise<ServiceResponse<PropertyImage>> {
  const ownership = await assertOwner(propertyId, ownerId);
  if (!ownership.success) return { success: false, error: ownership.error };

  // Confirm the target belongs to this property before touching the current primary,
  // so a bad id cannot leave the property with no primary image.
  const { data: target, error: targetError } = await supabase
    .from('property_images')
    .select('id, moderation_status')
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .single();

  if (targetError || !target) return { success: false, error: 'Image not found' };
  if ((target as { moderation_status: ImageModerationStatus }).moderation_status !== 'approved') {
    return {
      success: false,
      error: 'Only approved images can be set as the primary image',
      statusCode: 409,
    };
  }

  await supabase
    .from('property_images')
    .update({ is_primary: false })
    .eq('property_id', propertyId);

  const { data, error } = await supabase
    .from('property_images')
    .update({ is_primary: true })
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .select(OWNER_IMAGE_COLUMNS)
    .single();

  if (error) return { success: false, error: 'Image not found' };

  await invalidatePropertyCache(propertyId);
  return { success: true, data: data as PropertyImage };
}

export interface ModerateImageInput {
  propertyId: string;
  imageId: string;
  actorId: string;
  decision: string;
  reason?: string | null;
}

/**
 * Apply a moderation decision to a property image.
 *
 * Checks the transition, writes the new state, appends an audit event, and invalidates
 * the cached property. Rejected and removed images are deleted from storage, so their
 * bytes are no longer reachable through the public bucket. The database row is kept:
 * it holds the reason and the audit link.
 *
 * Authorization (admin scope) is enforced at the route. This function only checks state.
 */
export async function moderatePropertyImage(
  input: ModerateImageInput
): Promise<ServiceResponse<PropertyImage>> {
  const { propertyId, imageId, actorId, decision } = input;
  const reason = input.reason?.trim() || null;

  const inputError = validateModerationInput(decision, reason);
  if (inputError) return { success: false, error: inputError, statusCode: 400 };

  const { data: current, error: currentError } = await supabase
    .from('property_images')
    .select(OWNER_IMAGE_COLUMNS)
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .single();

  if (currentError || !current) return { success: false, error: 'Image not found' };

  const image = current as PropertyImage;
  const from = image.moderation_status ?? 'approved';
  const to = decision as ImageModerationDecision;

  if (!canTransitionImageStatus(from, to)) {
    return {
      success: false,
      error: `Cannot change moderation status from ${from} to ${to}`,
      statusCode: 409,
    };
  }

  // Guard on the current status so two moderators cannot both apply a decision.
  const { data: updated, error: updateError } = await supabase
    .from('property_images')
    .update({
      moderation_status: to,
      moderation_reason: to === 'approved' ? null : reason,
      moderated_at: new Date().toISOString(),
      moderated_by: actorId,
      // A removed or rejected primary image must not stay primary.
      ...(to === 'approved' ? {} : { is_primary: false }),
    })
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .eq('moderation_status', from)
    .select(OWNER_IMAGE_COLUMNS)
    .single();

  if (updateError || !updated) {
    return {
      success: false,
      error: 'Image moderation status changed concurrently, please reload and retry',
      statusCode: 409,
    };
  }

  const { error: auditError } = await supabase.from('property_image_moderation_events').insert({
    image_id: imageId,
    property_id: propertyId,
    actor_id: actorId,
    from_status: from,
    to_status: to,
    reason,
  });
  if (auditError) {
    console.error('[propertyImage] moderation audit insert failed', {
      imageId,
      error: auditError.message,
    });
    return { success: false, error: 'Moderation applied but audit record failed', statusCode: 500 };
  }

  if (to === 'rejected' || to === 'removed') {
    await cleanupStorageObjects(image.url, image.thumbnail_url ?? null);
    if (image.is_primary) await promoteFirstApproved(propertyId);
  }

  await invalidatePropertyCache(propertyId);

  return { success: true, data: updated as PropertyImage };
}

async function promoteFirstApproved(propertyId: string): Promise<void> {
  const { data: next } = await supabase
    .from('property_images')
    .select('id')
    .eq('property_id', propertyId)
    .eq('moderation_status', 'approved')
    .order('display_order', { ascending: true })
    .limit(1)
    .single();

  if (next) {
    await supabase
      .from('property_images')
      .update({ is_primary: true })
      .eq('id', (next as { id: string }).id);
  }
}
