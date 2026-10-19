import { supabase } from '@/config/supabase.js';
import { uploadImage, deleteImage as deleteStorageImage } from '@/config/supabase-storage.js';
import { env } from '@/config/env.js';
import * as cache from './cache.service.js';
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
  created_at?: string;
}

/**
 * Upload a new image for a property and store its record.
 *
 * @param propertyId - UUID of the property
 * @param ownerId - UUID of the requesting user (must be property owner)
 * @param file - Multer file object
 * @returns The created PropertyImage record
 */
export async function addPropertyImage(
  propertyId: string,
  ownerId: string,
  file: Express.Multer.File,
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

  // Count existing images BEFORE uploading to storage
  const { count, error: countError } = await supabase
    .from('property_images')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', propertyId);

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
    .select()
    .single();

  if (error) return { success: false, error: error.message };

  // Invalidate the cached property detail so the new image is visible immediately.
  await cache.del(`property:${propertyId}`);

  return { success: true, data: data as PropertyImage };
}

/**
 * Get all images for a property, ordered by display_order.
 *
 * @param propertyId - UUID of the property
 */
export async function getPropertyImages(propertyId: string): Promise<ServiceResponse<PropertyImage[]>> {
  const { data, error } = await supabase
    .from('property_images')
    .select('*')
    .eq('property_id', propertyId)
    .order('display_order', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PropertyImage[] };
}

/**
 * Delete a property image from storage and the database.
 *
 * @param propertyId - UUID of the property
 * @param imageId - UUID of the image record
 * @param ownerId - UUID of the requesting user
 */
export async function removePropertyImage(
  propertyId: string,
  imageId: string,
  ownerId: string,
): Promise<ServiceResponse<void>> {
  // Verify ownership
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const { data: image, error: imgError } = await supabase
    .from('property_images')
    .select('url, thumbnail_url, is_primary')
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .single();

  if (imgError || !image) return { success: false, error: 'Image not found' };

  // Remove from storage (both main and thumbnail)
  await deleteStorageImage((image as PropertyImage).url, (image as PropertyImage).thumbnail_url);

  const { error } = await supabase.from('property_images').delete().eq('id', imageId);
  if (error) return { success: false, error: error.message };

  // Invalidate the cached property detail so the removed image is no longer served.
  await cache.del(`property:${propertyId}`);

  // If deleted image was primary, promote next one
  if ((image as PropertyImage).is_primary) {
    const { data: next } = await supabase
      .from('property_images')
      .select('id')
      .eq('property_id', propertyId)
      .order('display_order', { ascending: true })
      .limit(1)
      .single();

    if (next) {
      await supabase.from('property_images').update({ is_primary: true }).eq('id', (next as { id: string }).id);
    }
  }

  return { success: true };
}

/**
 * Reorder images for a property by providing a full ordered list of image IDs.
 * Updates display_order for each image to match the given array index.
 *
 * @param propertyId - UUID of the property
 * @param ownerId - UUID of the requesting user
 * @param orderedIds - Image IDs in the new desired order
 */
export async function reorderPropertyImages(
  propertyId: string,
  ownerId: string,
  orderedIds: string[],
): Promise<ServiceResponse<PropertyImage[]>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const updates = orderedIds.map((id, index) =>
    supabase
      .from('property_images')
      .update({ display_order: index + 1 })
      .eq('id', id)
      .eq('property_id', propertyId),
  );

  await Promise.all(updates);

  const { data, error } = await supabase
    .from('property_images')
    .select('*')
    .eq('property_id', propertyId)
    .order('display_order', { ascending: true });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PropertyImage[] };
}

/**
 * Set an image as the primary image for a property.
 *
 * @param propertyId - UUID of the property
 * @param imageId - UUID of the image to promote
 * @param ownerId - UUID of the requesting user
 */
export async function setPrimaryImage(
  propertyId: string,
  imageId: string,
  ownerId: string,
): Promise<ServiceResponse<PropertyImage>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  // Confirm the target belongs to this property before touching the current primary,
  // so a bad id cannot leave the property with no primary image.
  const { data: target, error: targetError } = await supabase
    .from('property_images')
    .select('id')
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .single();

  if (targetError || !target) return { success: false, error: 'Image not found' };

  await supabase
    .from('property_images')
    .update({ is_primary: false })
    .eq('property_id', propertyId);

  const { data, error } = await supabase
    .from('property_images')
    .update({ is_primary: true })
    .eq('id', imageId)
    .eq('property_id', propertyId)
    .select()
    .single();

  if (error) return { success: false, error: 'Image not found' };
  return { success: true, data: data as PropertyImage };
}
