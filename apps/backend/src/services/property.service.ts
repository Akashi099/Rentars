/**
 * Property service — business logic layer between the property controller
 * and Supabase / blockchain clients.
 *
 * All functions return a ServiceResponse so controllers stay thin and
 * error handling is consistent.
 */

import { supabase } from '@/config/supabase.js';
import * as cache from './cache.service.js';
import type { ServiceResponse } from './index.js';
import type { PaginatedResult } from '../types/pagination.js';
import { buildSearchOrderClauses } from '../utils/searchSort.js';
import { executePaginatedQuery } from '../utils/pagination.js';
import { CANONICAL_AMENITIES } from '@/types/amenities.js';
import { sanitizeLongText, sanitizeShortText } from '@/utils/sanitize.js';
import { generateSlug } from '@/utils/slug.js';

export interface PropertyImage {
  id: string;
  url: string;
  is_primary?: boolean;
  display_order?: number;
}

const TTL_ALL = 60;
const TTL_ONE = 300;
const TTL_FEATURED = 120;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape of a property row as stored in Supabase.
 * Extend this interface as columns are added to the `properties` table.
 */
export interface Property {
  id: string;
  owner_id?: string;
  title: string;
  description?: string;
  price_per_night?: number;
  status?: string;
  city?: string;
  country?: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  max_guests?: number;
  amenities?: string[];
  images?: PropertyImage[];
  on_chain_id?: number;
  // Exact coordinates — redacted on public responses (see locationPrivacy.ts)
  latitude?: number | null;
  longitude?: number | null;
  // Property classification (migration 00028)
  property_type?: string;

  // House rules
  pets_allowed?: boolean;
  smoking_allowed?: boolean;
  events_allowed?: boolean;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  additional_rules?: string | null;
  // Denormalized rating aggregates
  average_rating?: number;
  review_count?: number;
  // Featured listing window (migration 00022)
  // A property is currently featured when featured_until > NOW()
  featured_until?: string | null;
  featured_weight?: number;
  // Human-readable URL slug (migration 00024)
  slug?: string;
  created_at?: string;
  updated_at?: string;
  // Soft-delete tombstone (migration 00032).
  // NULL = active listing. Non-null = removed by host.
  deleted_at?: string | null;
  // Draft status (migration 00060) — 'draft', 'active', 'archived'
  draft_status?: string;
  publish_at?: string | null;
}

/**
 * Maximum number of featured listings surfaced in a single response.
 * Enforced by getFeaturedProperties and searchPropertiesWithFeatured.
 */
export const FEATURED_CAP = 6;

/**
 * Returns true when a property is currently within its feature window.
 * Works purely from the in-memory object — no DB round-trip needed.
 */
export function isFeaturedNow(property: Pick<Property, 'featured_until'>): boolean {
  if (!property.featured_until) return false;
  return new Date(property.featured_until) > new Date();
}

/** Fields that are copied when duplicating a property. */
const DUPLICATE_FIELDS = [
  'title',
  'description',
  'price_per_night',
  'city',
  'country',
  'address',
  'bedrooms',
  'bathrooms',
  'max_guests',
  'amenities',
  'property_type',
  'pets_allowed',
  'smoking_allowed',
  'events_allowed',
  'quiet_hours_start',
  'quiet_hours_end',
  'additional_rules',
] as const;

/** Filters accepted by searchProperties. */
export interface PropertySearchFilters {
  city?: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  /** Minimum number of bathrooms (≥ filter). */
  min_bathrooms?: number;
  /** Filter by a single property type (exact match). */
  property_type?: string;
  status?: string;
  page?: number;
  pageSize?: number;
  limit?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateAmenities(amenities: string[]): string | null {
  const invalid = amenities.filter(
    (a) => !(CANONICAL_AMENITIES as readonly string[]).includes(a),
  );
  if (invalid.length > 0) {
    return `Unknown amenities: ${invalid.join(', ')}. Allowed: ${CANONICAL_AMENITIES.join(', ')}`;
  }
  return null;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Retrieve all active (non-soft-deleted) properties.
 */
export async function getAllProperties(page = 1, pageSize = 20): Promise<ServiceResponse<PaginatedResult<Property>>> {
  const query = supabase
    .from('properties')
    .select('*', { count: 'exact' })
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

/**
 * Retrieve a single property by its Supabase row ID.
 *
 * Soft-deleted properties (deleted_at IS NOT NULL) are hidden from public reads.
 * Owners can still retrieve their own soft-deleted listings by passing their
 * user ID as `requesterId` and setting `includeDeleted: true`.
 *
 * Responses are cached in Redis with a TTL of {@link TTL_ONE} seconds.
 * Cache is bypassed when the requesting user is the owner of a draft/unpublished
 * listing so they always see their latest edits. Draft properties are never
 * written to the cache.
 *
 * @param id              - UUID of the property row.
 * @param requesterId     - Optional ID of the authenticated caller.
 * @param includeDeleted  - When true and the requester is the owner, soft-deleted
 *                          rows are returned. Defaults to false.
 */
export async function getPropertyById(
  id: string,
  requesterId?: string,
  includeDeleted = false,
): Promise<ServiceResponse<Property>> {
  if (!id) {
    return { success: false, error: 'Property ID is required' };
  }

  const cacheKey = `property:${id}`;
  const cached = await cache.get<Property>(cacheKey);
  if (cached) {
    // Owners always get fresh data for their own draft/unpublished listings.
    const isDraftOwnedByRequester =
      requesterId && cached.status === 'draft' && cached.owner_id === requesterId;
    if (!isDraftOwnedByRequester) {
      // If the cached entry is soft-deleted, only surface it to the owner when
      // includeDeleted is explicitly requested.
      if (cached.deleted_at) {
        if (!includeDeleted || cached.owner_id !== requesterId) {
          return { success: false, error: 'Property not found' };
        }
      }
      return { success: true, data: cached };
    }
  }

  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    return { success: false, error: 'Property not found' };
  }

  const property = data as Property;

  // Enforce soft-delete visibility: hide from anyone who isn't the owner
  // requesting their own deleted history.
  if (property.deleted_at) {
    if (!includeDeleted || property.owner_id !== requesterId) {
      return { success: false, error: 'Property not found' };
    }
  }

  const { data: imageRows, error: imageError } = await supabase
    .from('property_images')
    .select('id, url, is_primary, display_order')
    .eq('property_id', id)
    .order('display_order', { ascending: true });

  if (!imageError && Array.isArray(imageRows)) {
    property.images = imageRows.map((row) => ({
      id: row.id,
      url: row.url,
      is_primary: row.is_primary,
      display_order: row.display_order,
    }));
  }

  // Draft properties change frequently and are owner-only — do not cache them.
  // Soft-deleted properties should also not be cached on the public key to
  // prevent stale hidden listings from being served.
  if (property.status !== 'draft' && !property.deleted_at) {
    await cache.set(cacheKey, property, TTL_ONE);
  }

  return { success: true, data: property };
}

/**
 * Create a new property record.
 *
 * @param payload - Property fields to insert. `title` is required.
 */
export async function createProperty(
  payload: Partial<Property>,
): Promise<ServiceResponse<Property>> {
  // Trim first so whitespace-only titles are caught by the truthiness guard (#419)
  const trimmedTitle = payload.title?.trim();
  if (!trimmedTitle) {
    return { success: false, error: 'Property title is required' };
  }

  if (payload.amenities && payload.amenities.length > 0) {
    const amenityError = validateAmenities(payload.amenities);
    if (amenityError) return { success: false, error: amenityError };
  }

  // Sanitize user-generated text fields before storing
  const sanitized: Partial<Property> = {
    ...payload,
    title: sanitizeShortText(trimmedTitle, 255),
    description: payload.description ? sanitizeLongText(payload.description, 10_000) : undefined,
    additional_rules: payload.additional_rules
      ? sanitizeLongText(payload.additional_rules, 2_000)
      : undefined,
  };

  // Guard against titles that produce no valid slug (#418).
  // generateSlug falls back to "property-<suffix>" for empty bases, but a title
  // with no sluggable characters is itself invalid — reject it early.
  const prospectiveSlug = generateSlug(trimmedTitle, payload.city, 'probe');
  if (prospectiveSlug.startsWith('property-')) {
    return { success: false, error: 'Property title must contain at least one letter or digit' };
  }

  const { data, error } = await supabase
    .from('properties')
    .insert(sanitized)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  const property = data as Property;

  // Generate and persist the URL slug now that we have the row id
  const slug = generateSlug(property.title, property.city, property.id);
  const { error: slugErr } = await supabase
    .from('properties')
    .update({ slug })
    .eq('id', property.id);

  if (!slugErr) {
    property.slug = slug;
  } else {
    console.error('[createProperty] Failed to set slug:', slugErr.message);
  }

  await Promise.all([
    cache.del('properties:all'),
    cache.del('properties:featured'),
  ]);

  // Fan-out new-property notifications to the host's followers when the
  // property is published (status === 'available').  Fire-and-forget so
  // a notification failure never blocks the create response.
  if (property.status === 'available' && property.owner_id) {
    import('./notification.service.js').then(({ notifyHostFollowers }) => {
      notifyHostFollowers({
        propertyId:    property.id,
        propertyTitle: property.title,
        propertySlug:  property.slug ?? property.id,
        hostId:        property.owner_id!,
        hostName:      property.owner_id!, // caller may enrich via profile lookup
      }).catch((err) =>
        console.error('[createProperty] notifyHostFollowers failed:', err),
      );
    });

    // Notify tenants whose saved searches match this new listing.
    import('./savedSearch.service.js').then(({ notifyMatchingSavedSearches }) => {
      notifyMatchingSavedSearches(property).catch((err) =>
        console.error('[createProperty] notifyMatchingSavedSearches failed:', err),
      );
    });
  }

  return { success: true, data: property };
}

/**
 * Update an existing property record.
 *
 * @param id - UUID of the property row to update.
 * @param payload - Fields to update. At least one field must be provided.
 */
export async function updateProperty(
  id: string,
  payload: Partial<Property>,
  changedBy?: string,
  changeSource = 'host_edit',
  changeNotes?: string,
): Promise<ServiceResponse<Property>> {
  if (!id) {
    return { success: false, error: 'Property ID is required' };
  }

  if (Object.keys(payload).length === 0) {
    return { success: false, error: 'No fields provided for update' };
  }

  if (payload.amenities && payload.amenities.length > 0) {
    const amenityError = validateAmenities(payload.amenities);
    if (amenityError) return { success: false, error: amenityError };
  }

  // Sanitize user-generated text fields before storing
  const sanitized: Partial<Property> = { ...payload };
  if (payload.title !== undefined) {
    sanitized.title = sanitizeShortText(payload.title, 255);
  }
  if (payload.description !== undefined) {
    sanitized.description = sanitizeLongText(payload.description, 10_000);
  }
  if (payload.additional_rules !== undefined) {
    sanitized.additional_rules = sanitizeLongText(payload.additional_rules, 2_000);
  }

  // Fetch the current state before updating so we can diff for the version snapshot.
  const { data: beforeData } = await supabase
    .from('properties')
    .select('*')
    .eq('id', id)
    .single();

  const before = (beforeData as Property | null) ?? {};

  const { data, error } = await supabase
    .from('properties')
    .update(sanitized)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  const updated = data as Property;

  // If the property has no slug yet (legacy row), generate one now
  if (!updated.slug) {
    const slug = generateSlug(updated.title, updated.city, updated.id);
    const { error: slugErr } = await supabase
      .from('properties')
      .update({ slug })
      .eq('id', id);
    if (!slugErr) updated.slug = slug;
  }

  await Promise.all([
    cache.del(`property:${id}`),
    cache.del('properties:all'),
    cache.del('properties:featured'),
  ]);

  // Fan-out new-property notifications when a draft is published
  // (status transitions to 'available' in this update).
  const wasJustPublished =
    payload.status === 'available' && updated.status === 'available' && updated.owner_id;

  if (wasJustPublished) {
    import('./notification.service.js').then(({ notifyHostFollowers }) => {
      notifyHostFollowers({
        propertyId:    updated.id,
        propertyTitle: updated.title,
        propertySlug:  updated.slug ?? updated.id,
        hostId:        updated.owner_id!,
        hostName:      updated.owner_id!,
      }).catch((err) =>
        console.error('[updateProperty] notifyHostFollowers failed:', err),
      );
    });
  }

  // Re-run saved-search matching when a listing becomes available or changes in a
  // way a saved search can match on. Delivery rows keep each (search, listing)
  // pair to a single alert, so repeated edits do not resend.
  const becameAvailable =
    (before as Partial<Property>).status !== 'available' && updated.status === 'available';
  const matchFieldChanged = SAVED_SEARCH_MATCH_FIELDS.some((field) => payload[field] !== undefined);
  if (updated.status === 'available' && (becameAvailable || matchFieldChanged)) {
    import('./savedSearch.service.js').then(({ notifyMatchingSavedSearches }) => {
      notifyMatchingSavedSearches(updated).catch((err) =>
        console.error('[updateProperty] notifyMatchingSavedSearches failed:', err),
      );
    });
  }

  // Record a version snapshot when tracked fields changed.
  recordPropertyVersion(id, before, updated, changedBy, changeSource, changeNotes).catch((err) =>
    console.warn('[updateProperty] version record failed:', err),
  );

  return { success: true, data: updated };
}

/** Listing fields a saved search can match on. */
const SAVED_SEARCH_MATCH_FIELDS = [
  'title',
  'city',
  'country',
  'price_per_night',
  'bedrooms',
  'bathrooms',
  'max_guests',
  'amenities',
  'property_type',
] as const satisfies readonly (keyof Property)[];

/**
 * Soft-delete a property record by setting `deleted_at` to the current
 * timestamp.  The row is preserved in the database so that historical bookings,
 * reviews, and on-chain references continue to resolve correctly.
 *
 * The listing is immediately hidden from all public reads and cannot receive
 * new bookings after this call returns.
 *
 * @param id - UUID of the property row to soft-delete.
 */
export async function deleteProperty(id: string): Promise<ServiceResponse<void>> {
  if (!id) {
    return { success: false, error: 'Property ID is required' };
  }

  const { error } = await supabase
    .from('properties')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null); // idempotent: only update if not already deleted

  if (error) {
    return { success: false, error: error.message };
  }

  await Promise.all([
    cache.del(`property:${id}`),
    cache.del('properties:all'),
    cache.del('properties:featured'),
  ]);

  return { success: true };
}

/**
 * Retrieve a single active (non-soft-deleted) property by its URL slug.
 *
 * The slug uniquely identifies a property (see migration 00024).
 * Results are cached on the same `property:{id}` key as `getPropertyById`
 * so the two lookups share the same cache entry.
 *
 * @param slug - The URL slug (e.g. "cozy-loft-downtown-paris-a1b2c3").
 */
export async function getPropertyBySlug(
  slug: string,
): Promise<ServiceResponse<Property>> {
  if (!slug) {
    return { success: false, error: 'Slug is required' };
  }

  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('slug', slug)
    .is('deleted_at', null)
    .single();

  if (error) {
    return { success: false, error: 'Property not found' };
  }

  const property = data as Property;

  // Warm the id-based cache entry so subsequent id lookups are fast
  if (property.status !== 'draft') {
    await cache.set(`property:${property.id}`, property, TTL_ONE);
  }

  return { success: true, data: property };
}

export async function getFeaturedProperties(
  limit = FEATURED_CAP,
): Promise<ServiceResponse<Property[]>> {
  const cap = Math.min(limit, FEATURED_CAP);
  const cacheKey = `properties:featured:${cap}`;
  const cached = await cache.get<Property[]>(cacheKey);
  if (cached) return { success: true, data: cached };

  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('status', 'available')
    .is('deleted_at', null)
    .not('featured_until', 'is', null)
    .gt('featured_until', now)
    .order('featured_weight', { ascending: false })
    .order('featured_until', { ascending: false })
    .limit(cap);

  if (error) return { success: false, error: error.message };

  const properties = (data ?? []) as Property[];
  await cache.set(cacheKey, properties, TTL_FEATURED);
  return { success: true, data: properties };
}

/**
 * Mark a property as featured until the given timestamp.
 *
 * Admin-only.  The caller is responsible for verifying the requester has
 * admin privileges before calling this function.
 *
 * @param propertyId   - UUID of the property to feature.
 * @param featuredUntil - ISO 8601 datetime string; must be in the future.
 * @param weight        - Optional ordering tiebreaker (default 0).
 */
export async function setFeatured(
  propertyId: string,
  featuredUntil: string,
  weight = 0,
): Promise<ServiceResponse<Property>> {
  if (!propertyId) {
    return { success: false, error: 'Property ID is required' };
  }

  const until = new Date(featuredUntil);
  if (Number.isNaN(until.getTime())) {
    return { success: false, error: 'featuredUntil must be a valid ISO 8601 datetime' };
  }
  if (until <= new Date()) {
    return { success: false, error: 'featuredUntil must be a future date' };
  }

  const { data, error } = await supabase
    .from('properties')
    .update({
      featured_until: until.toISOString(),
      featured_weight: weight,
    })
    .eq('id', propertyId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Bust all featured-cap variants and the individual property cache
  await Promise.all([
    cache.del(`property:${propertyId}`),
    cache.del('properties:featured'),
    ...Array.from({ length: FEATURED_CAP }, (_, i) =>
      cache.del(`properties:featured:${i + 1}`),
    ),
  ]);

  return { success: true, data: data as Property };
}

/**
 * Remove the featured status from a property immediately.
 *
 * Admin-only.  Sets featured_until to NULL and featured_weight to 0.
 *
 * @param propertyId - UUID of the property to unfeature.
 */
export async function clearFeatured(
  propertyId: string,
): Promise<ServiceResponse<Property>> {
  if (!propertyId) {
    return { success: false, error: 'Property ID is required' };
  }

  const { data, error } = await supabase
    .from('properties')
    .update({ featured_until: null, featured_weight: 0 })
    .eq('id', propertyId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  await Promise.all([
    cache.del(`property:${propertyId}`),
    cache.del('properties:featured'),
    ...Array.from({ length: FEATURED_CAP }, (_, i) =>
      cache.del(`properties:featured:${i + 1}`),
    ),
  ]);

  return { success: true, data: data as Property };
}

export async function searchProperties(
  filters: PropertySearchFilters,
): Promise<ServiceResponse<PaginatedResult<Property>>> {
  const page = Math.max(filters.page ?? 1, 1);
  const pageSize = Math.min(filters.pageSize ?? filters.limit ?? 20, 100);
  let query = supabase.from('properties').select('*', { count: 'exact' }).is('deleted_at', null);

  if (filters.city) {
    query = query.ilike('city', `%${filters.city}%`);
  }

  if (filters.country) {
    query = query.ilike('country', `%${filters.country}%`);
  }

  if (filters.min_price !== undefined) {
    query = query.gte('price_per_night', filters.min_price);
  }

  if (filters.max_price !== undefined) {
    query = query.lte('price_per_night', filters.max_price);
  }

  if (filters.bedrooms !== undefined) {
    query = query.gte('bedrooms', filters.bedrooms);
  }

  if (filters.min_bathrooms !== undefined) {
    query = query.gte('bathrooms', filters.min_bathrooms);
  }

  if (filters.property_type) {
    query = query.eq('property_type', filters.property_type);
  }

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  query = query.order('created_at', { ascending: false });

  const response = await executePaginatedQuery(query, page, pageSize);
  if (response.error) return { success: false, error: response.error };
  return { success: true, data: response.result };
}

export interface AdvancedSearchFilters extends PropertySearchFilters {
  query?: string;
  amenities?: string[];
  /**
   * Filter by one or more property types (set membership — OR logic).
   * Values must match the constraint in migration 00028:
   * Apartment | House | Villa | Condo | Studio | Room | Townhouse | Cabin | Loft | Boat
   */
  property_types?: string[];
  /** Minimum number of bathrooms (≥ filter). */
  min_bathrooms?: number;
  latitude?: number;
  longitude?: number;
  radius_km?: number;
  /** Bounding-box search (used by map viewport queries) */
  bounds?: { north: number; south: number; east: number; west: number };
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  sortBy?: 'price_asc' | 'price_desc' | 'distance' | 'rating' | 'newest' | 'relevance';
  page?: number;
  limit?: number;
}

export interface SearchResult {
  id: string;
  title: string;
  price_per_night?: number;
  city?: string;
  country?: string;
  bedrooms?: number;
  bathrooms?: number;
  property_type?: string;
  amenities?: string[];
  images?: string[];
  slug?: string;
  distance_km?: number;
  /** Denormalized average rating from the properties table */
  rating?: number;
  review_count?: number;
  is_featured?: boolean;
  latitude?: number;
  longitude?: number;
  created_at?: string;
}

export interface SearchPageResult {
  data: SearchResult[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Advanced property search with full-text search, availability filtering,
 * sorting, and offset pagination.
 *
 * Date-range availability: when checkIn + checkOut are provided, properties
 * that have any active booking (non-cancelled) overlapping those dates are
 * excluded from the result set via a NOT IN sub-query.
 */
export async function advancedSearch(
  filters: AdvancedSearchFilters,
): Promise<ServiceResponse<SearchPageResult>> {
  // Skip cache when date filters are present — availability is real-time
  const cacheKey = (!filters.checkIn && !filters.checkOut)
    ? `search:${JSON.stringify(filters)}`
    : null;

  if (cacheKey) {
    const cached = await cache.get<SearchPageResult>(cacheKey);
    if (cached) return { success: true, data: cached };
  }

  const limit = Math.min(filters.limit || 20, 100);
  const page = Math.max(filters.page || 1, 1);

  // ── 1. Resolve IDs to exclude based on date-range availability ──────────
  let excludedPropertyIds: string[] = [];

  if (filters.checkIn && filters.checkOut) {
    const { data: bookedRows } = await supabase
      .from('bookings')
      .select('property_id')
      .neq('status', 'Cancelled')
      .lt('check_in', filters.checkOut)
      .gt('check_out', filters.checkIn);

    if (bookedRows && bookedRows.length > 0) {
      excludedPropertyIds = [
        ...new Set((bookedRows as { property_id: string }[]).map((r) => r.property_id)),
      ];
    }

    // Also exclude properties that have a blocked availability_range overlapping the dates
    const { data: blockedRows } = await supabase
      .from('availability_ranges')
      .select('property_id')
      .eq('is_available', false)
      .lt('start_date', filters.checkOut)
      .gt('end_date', filters.checkIn);

    if (blockedRows && blockedRows.length > 0) {
      const blockedIds = (blockedRows as { property_id: string }[]).map((r) => r.property_id);
      excludedPropertyIds = [...new Set([...excludedPropertyIds, ...blockedIds])];
    }
  }

  // ── 2. Build the base query ────────────────────────────────────────────────
  // We run two parallel queries: one for total count, one for page data.
  const buildQuery = (forCount: boolean) => {
    let q = forCount
      ? supabase.from('properties').select('id', { count: 'exact', head: true })
      : supabase.from('properties').select('*');

    // Always exclude soft-deleted listings from public search
    q = q.is('deleted_at', null);

    // Full-text search on title/description
    if (filters.query) {
      const tsQuery = toTsQuery(filters.query);
      if (tsQuery) {
        q = q.textSearch('search_vector', tsQuery, { config: 'english' });
      }
    }

    // Location filters
    if (filters.city) q = q.ilike('city', `%${filters.city}%`);
    if (filters.country) q = q.ilike('country', `%${filters.country}%`);

    // Bounding-box filter (map viewport)
    if (filters.bounds) {
      const { north, south, east, west } = filters.bounds;
      q = q
        .gte('latitude', south)
        .lte('latitude', north)
        .gte('longitude', west)
        .lte('longitude', east);
    }

  // Bathroom filter (minimum bathrooms)
  if (filters.min_bathrooms !== undefined) query = query.gte('bathrooms', filters.min_bathrooms);

  // Property type filter (set membership — OR across supplied values)
  if (filters.property_types && filters.property_types.length > 0) {
    // Supabase .in() generates a SQL `column IN (v1, v2, ...)` clause which
    // uses the idx_properties_property_type index on low-cardinality values.
    query = query.in('property_type', filters.property_types);
  } else if (filters.property_type) {
    // Single-value convenience path (from simple searchProperties call)
    query = query.eq('property_type', filters.property_type);
  }

  // Guest capacity
  if (filters.guests !== undefined) query = query.gte('max_guests', filters.guests);

    // Bedroom filter
    if (filters.bedrooms !== undefined) q = q.gte('bedrooms', filters.bedrooms);

    // Guest capacity
    if (filters.guests !== undefined) q = q.gte('max_guests', filters.guests);

    // Amenities — must contain all requested amenities
    if (filters.amenities && filters.amenities.length > 0) {
      q = q.contains('amenities', filters.amenities);
    }

    // Status
    if (filters.status) q = q.eq('status', filters.status);
    else q = q.eq('status', 'available');

    // Exclude unavailable properties (booked / blocked dates)
    if (excludedPropertyIds.length > 0) {
      q = q.not('id', 'in', `(${excludedPropertyIds.map((id) => `"${id}"`).join(',')})`);
    }

    return q;
  };

  // ── 3. Run count + data queries in parallel ───────────────────────────────
  const countQuery = buildQuery(true);
  let dataQuery = buildQuery(false);

  // Sorting (ends with `id` so pages are stable when sort keys tie)
  const sortBy = filters.sortBy || 'newest';
  for (const clause of buildSearchOrderClauses(sortBy)) {
    dataQuery = dataQuery.order(clause.column, clause.options);
  }

  // Pagination
  const from = (page - 1) * limit;
  dataQuery = dataQuery.range(from, from + limit - 1);

  const [countResult, dataResult] = await Promise.all([countQuery, dataQuery]);

  if (dataResult.error) {
    return { success: false, error: dataResult.error.message };
  }

  const total = (countResult as { count?: number | null }).count ?? 0;
  let properties = (dataResult.data ?? []) as Property[];

  // ── 4. Post-query: distance sort using in-memory haversine (fallback) ─────
  if (
    sortBy === 'distance' &&
    filters.latitude !== undefined &&
    filters.longitude !== undefined
  ) {
    const lat0 = filters.latitude;
    const lng0 = filters.longitude;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const haversine = (lat: number, lng: number) => {
      const R = 6371;
      const dLat = toRad(lat - lat0);
      const dLng = toRad(lng - lng0);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat0)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    // Filter by radius_km if provided, then sort
    const withDist = properties
      .filter((p) => {
        if (p.latitude == null || p.longitude == null) return false;
        if (filters.radius_km === undefined) return true;
        return haversine(p.latitude, p.longitude) <= filters.radius_km;
      })
      .map((p) => ({
        property: p,
        dist: p.latitude != null && p.longitude != null
          ? haversine(p.latitude, p.longitude)
          : Infinity,
      }));

    withDist.sort((a, b) => a.dist - b.dist);

    const results: SearchResult[] = withDist.map(({ property: p, dist }) => ({
      id: p.id,
      title: p.title,
      price_per_night: p.price_per_night,
      city: p.city,
      country: p.country,
      bedrooms: p.bedrooms,
      max_guests: p.max_guests,
      amenities: p.amenities,
      images: p.images,
      slug: p.slug,
      latitude: p.latitude ?? undefined,
      longitude: p.longitude ?? undefined,
      rating: p.average_rating ?? 0,
      review_count: p.review_count ?? 0,
      distance_km: Math.round(dist * 10) / 10,
      is_featured: false,
      created_at: p.created_at,
    }));

    const pageResult: SearchPageResult = {
      data: results,
      total,
      page,
      limit,
      hasMore: from + properties.length < total,
    };

    if (cacheKey) await cache.set(cacheKey, pageResult, 60);
    return { success: true, data: pageResult };
  }

  // ── 4b. Post-query: relevance sort using weighted field scoring ───────────
  // Mirrors the tsvector weights (A=title, B=city, C=description, D=amenities)
  // so results match what ts_rank_cd would return for the same query.
  if (sortBy === 'relevance' && filters.query && properties.length > 0) {
    const terms = filters.query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean);

    if (terms.length > 0) {
      const score = (p: Property): number => {
        let s = 0;
        const title = (p.title ?? '').toLowerCase();
        const city = (p.city ?? '').toLowerCase();
        const desc = (p.description ?? '').toLowerCase();
        const amenities = (p.amenities ?? []).join(' ').toLowerCase();

        for (const t of terms) {
          if (title.includes(t)) s += 4;   // weight A
          if (city.includes(t)) s += 3;    // weight B
          if (desc.includes(t)) s += 2;    // weight C
          if (amenities.includes(t)) s += 1; // weight D
        }
        return s;
      };

      properties.sort((a, b) => score(b) - score(a));
    }
  }

  // ── 5. Map to SearchResult ─────────────────────────────────────────────────
  const results: SearchResult[] = properties.map((p) => ({
    id: p.id,
    title: p.title,
    price_per_night: p.price_per_night,
    city: p.city,
    country: p.country,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    property_type: p.property_type,
    amenities: p.amenities,
    images: p.images,
    slug: p.slug,
    latitude: p.latitude ?? undefined,
    longitude: p.longitude ?? undefined,
    rating: p.average_rating ?? 0,
    review_count: p.review_count ?? 0,
    is_featured: false,
    created_at: p.created_at,
  }));

  const pageResult: SearchPageResult = {
    data: results,
    total,
    page,
    limit,
    hasMore: from + results.length < total,
  };

  if (cacheKey) await cache.set(cacheKey, pageResult, 60);
  return { success: true, data: pageResult };
}

/**
 * Convert a free-text search string into a safe PostgreSQL tsquery expression.
 *
 * All characters that have special meaning in tsquery syntax (`&`, `|`, `!`,
 * `(`, `)`, `:`, `*`, `'`, `\`) as well as every non-alphanumeric character
 * are stripped from each token before it is appended with the prefix-match
 * operator (`:*`).  This guarantees that user input can never alter the query
 * structure or produce a database syntax error.
 *
 * Exported so it can be unit-tested in isolation.
 */
export function toTsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/\s+/)
    // Keep only plain alphanumeric characters — strip everything else,
    // including all PostgreSQL tsquery operators (&, |, !, (, ), :, *, ', \).
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  if (tokens.length === 0) return '';
  return tokens.map((t) => `${t}:*`).join(' & ');
}

// ─── Historical / internal reads ─────────────────────────────────────────────

/**
 * Resolve minimal property data (id, title, slug) for use in historical
 * contexts such as review displays, booking receipts, and audit trails.
 *
 * Unlike `getPropertyById`, this function returns soft-deleted rows so that
 * historical records remain complete even after a host removes a listing.
 * It intentionally returns ONLY non-sensitive fields to avoid leaking data
 * from listings that are no longer publicly visible.
 *
 * @param id - UUID of the property row.
 */
export async function getPropertyForReview(
  id: string,
): Promise<ServiceResponse<Pick<Property, 'id' | 'title' | 'slug' | 'deleted_at'>>> {
  if (!id) {
    return { success: false, error: 'Property ID is required' };
  }

  const { data, error } = await supabase
    .from('properties')
    .select('id, title, slug, deleted_at')
    .eq('id', id)
    .single();

  if (error) {
    return { success: false, error: 'Property not found' };
  }

  return {
    success: true,
    data: data as Pick<Property, 'id' | 'title' | 'slug' | 'deleted_at'>,
  };
}

// ─── Duplicate ────────────────────────────────────────────────────────────────

export interface DuplicatePropertyOptions {
  /** When true the original's image URLs are copied to the draft. Defaults to false. */
  copyImages?: boolean;
}

/**
 * Duplicate an existing property into a new 'draft' record owned by the same host.
 *
 * Copied: title (+' (Copy)'), description, pricing, location, capacity, amenities,
 *         house rules, and optionally images.
 * NOT copied: bookings, reviews, availability ranges, on_chain_id.
 *
 * @param propertyId  - UUID of the source property.
 * @param requesterId - ID of the user making the request (must be the owner).
 * @param options     - Optional flags (copyImages).
 */
export async function duplicateProperty(
  propertyId: string,
  requesterId: string,
  options: DuplicatePropertyOptions = {},
): Promise<ServiceResponse<Property>> {
  if (!propertyId) {
    return { success: false, error: 'Property ID is required' };
  }

  // Fetch source
  const { data: source, error: fetchError } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (fetchError || !source) {
    return { success: false, error: 'Property not found' };
  }

  const src = source as Property;

  // Ownership check
  if (src.owner_id !== requesterId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  // Cannot duplicate a soft-deleted listing
  if (src.deleted_at) {
    return { success: false, error: 'Cannot duplicate a deleted property' };
  }

  // Build the clone payload from the allow-list
  const clone: Partial<Property> = {};
  for (const field of DUPLICATE_FIELDS) {
    if (src[field] !== undefined) {
      (clone as Record<string, unknown>)[field] = src[field];
    }
  }

  // Mark as draft and suffix the title
  clone.owner_id = requesterId;
  clone.status = 'draft';
  clone.title = `${src.title} (Copy)`;
  // on_chain_id intentionally excluded — draft is not on-chain

  if (options.copyImages && Array.isArray(src.images)) {
    clone.images = [...src.images];
  } else {
    clone.images = [];
  }

  const { data: newProperty, error: insertError } = await supabase
    .from('properties')
    .insert(clone)
    .select()
    .single();

  if (insertError) {
    return { success: false, error: insertError.message };
  }

  // Bust list caches so the draft shows up for the owner
  await Promise.all([
    cache.del('properties:all'),
    cache.del('properties:featured'),
  ]);

  return { success: true, data: newProperty as Property };
}

// ─── Draft Management ─────────────────────────────────────────────────────────

/**
 * Create a draft property for a host to fill in incrementally.
 * Requires only title and owner; other fields can be added later.
 */
export async function createDraftProperty(
  ownerId: string,
  title: string,
): Promise<ServiceResponse<Property>> {
  if (!title || title.trim().length === 0) {
    return { success: false, error: 'Title is required' };
  }

  const slug = generateSlug(title.trim());
  const { data, error } = await supabase
    .from('properties')
    .insert({
      owner_id: ownerId,
      title: sanitizeShortText(title.trim()),
      draft_status: 'draft',
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  // Bust cache
  await cache.del('properties:all');

  return { success: true, data: data as Property };
}

/**
 * Get all draft properties for a host with completion status.
 */
export async function getHostDrafts(
  ownerId: string,
): Promise<ServiceResponse<Property[]>> {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('draft_status', 'draft')
    .order('updated_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as Property[] };
}

/**
 * Validate that a property has required fields for publication.
 */
function validateForPublication(property: Property): string | null {
  const required = ['title', 'price_per_night', 'city', 'country', 'bedrooms', 'bathrooms', 'max_guests'];
  for (const field of required) {
    if (!property[field as keyof Property]) {
      return `Missing required field: ${field}`;
    }
  }

  if (!property.images || property.images.length === 0) {
    return 'At least one image is required';
  }

  return null;
}

/**
 * Publish a draft property to active listing.
 * Validates all required fields are present.
 */
export async function publishDraft(
  ownerId: string,
  propertyId: string,
): Promise<ServiceResponse<Property>> {
  const { data: property, error: fetchError } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .eq('owner_id', ownerId)
    .eq('draft_status', 'draft')
    .single();

  if (fetchError || !property) {
    return { success: false, error: 'Draft property not found' };
  }

  const validationError = validateForPublication(property as Property);
  if (validationError) {
    return { success: false, error: validationError };
  }

  const { data: updated, error: updateError } = await supabase
    .from('properties')
    .update({ draft_status: 'active', publish_at: new Date().toISOString() })
    .eq('id', propertyId)
    .select()
    .single();

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Bust caches
  await Promise.all([
    cache.del(`property:${propertyId}`),
    cache.del('properties:all'),
    cache.del('properties:featured'),
  ]);

  return { success: true, data: updated as Property };
}

/**
 * Get draft completion status as percentage.
 */
export function getDraftCompletionStatus(property: Property): {
  percentage: number;
  missingFields: string[];
} {
  const fields = {
    title: !!property.title,
    description: !!property.description,
    price_per_night: !!property.price_per_night,
    city: !!property.city,
    country: !!property.country,
    address: !!property.address,
    bedrooms: property.bedrooms !== null && property.bedrooms !== undefined,
    bathrooms: property.bathrooms !== null && property.bathrooms !== undefined,
    max_guests: !!property.max_guests,
    property_type: !!property.property_type,
    amenities: property.amenities && property.amenities.length > 0,
    images: property.images && property.images.length > 0,
  };

  const completed = Object.values(fields).filter(Boolean).length;
  const total = Object.keys(fields).length;
  const percentage = Math.round((completed / total) * 100);

  const missingFields = Object.entries(fields)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  return { percentage, missingFields };
}

// ─── Version history ──────────────────────────────────────────────────────────

/**
 * Fields whose changes are meaningful enough to snapshot in version history.
 * These are the fields that active bookings depend on.
 */
const VERSIONED_FIELDS: ReadonlyArray<keyof Property> = [
  'title',
  'description',
  'price_per_night',
  'bedrooms',
  'bathrooms',
  'max_guests',
  'amenities',
  'pets_allowed',
  'smoking_allowed',
  'events_allowed',
  'quiet_hours_start',
  'quiet_hours_end',
  'additional_rules',
  'address',
  'city',
  'country',
  'property_type',
] as const;

export interface PropertyVersion {
  id: string;
  property_id: string;
  version_number: number;
  snapshot: Partial<Property>;
  changed_fields: string[];
  changed_by: string | null;
  change_source: string;
  notes: string | null;
  created_at: string;
}

/**
 * Record a snapshot of a property's current tracked fields as a new version.
 * Called automatically inside updateProperty whenever meaningful fields change.
 *
 * @param propertyId   - UUID of the property.
 * @param before       - Property state before the update.
 * @param after        - Property state after the update.
 * @param changedBy    - UUID of the user who performed the update.
 * @param changeSource - Label for the audit trail (e.g. 'host_edit', 'rollback').
 * @param notes        - Optional human-readable note.
 */
export async function recordPropertyVersion(
  propertyId: string,
  before: Partial<Property>,
  after: Partial<Property>,
  changedBy: string | undefined,
  changeSource = 'host_edit',
  notes?: string,
): Promise<ServiceResponse<PropertyVersion>> {
  const changedFields = VERSIONED_FIELDS.filter((field) => {
    const a = JSON.stringify(before[field]);
    const b = JSON.stringify(after[field]);
    return a !== b;
  }) as string[];

  if (changedFields.length === 0) {
    return { success: false, error: 'No tracked fields changed; version not recorded' };
  }

  const snapshot: Partial<Property> = {};
  for (const field of VERSIONED_FIELDS) {
    if (after[field] !== undefined) {
      (snapshot as Record<string, unknown>)[field] = after[field];
    } else if (before[field] !== undefined) {
      (snapshot as Record<string, unknown>)[field] = before[field];
    }
  }

  const { data: versionNumber } = await supabase.rpc('next_property_version', {
    p_property_id: propertyId,
  });

  const { data, error } = await supabase
    .from('property_versions')
    .insert({
      property_id: propertyId,
      version_number: (versionNumber as number | null) ?? 1,
      snapshot,
      changed_fields: changedFields,
      changed_by: changedBy ?? null,
      change_source: changeSource,
      notes: notes ?? null,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: data as PropertyVersion };
}

/**
 * Return the full version history for a property, newest first.
 *
 * @param propertyId - UUID of the property.
 * @param limit      - Maximum number of versions to return (default 50).
 */
export async function getPropertyVersionHistory(
  propertyId: string,
  limit = 50,
): Promise<ServiceResponse<PropertyVersion[]>> {
  if (!propertyId) {
    return { success: false, error: 'Property ID is required' };
  }

  const { data, error } = await supabase
    .from('property_versions')
    .select('*')
    .eq('property_id', propertyId)
    .order('version_number', { ascending: false })
    .limit(Math.min(limit, 100));

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as PropertyVersion[] };
}

/**
 * Restore a property to a prior version by applying the snapshot as a new update.
 *
 * The rollback creates a brand-new version record rather than deleting history,
 * preserving full auditability.  Active booking snapshots are never affected.
 *
 * @param propertyId - UUID of the property.
 * @param versionId  - UUID of the property_versions row to restore.
 * @param actorId    - UUID of the user performing the rollback.
 */
export async function rollbackToVersion(
  propertyId: string,
  versionId: string,
  actorId: string,
): Promise<ServiceResponse<Property>> {
  if (!propertyId) return { success: false, error: 'Property ID is required' };
  if (!versionId)  return { success: false, error: 'Version ID is required' };
  if (!actorId)    return { success: false, error: 'Actor ID is required' };

  // Load the version to restore.
  const { data: versionData, error: versionError } = await supabase
    .from('property_versions')
    .select('*')
    .eq('id', versionId)
    .eq('property_id', propertyId)
    .single();

  if (versionError || !versionData) {
    return { success: false, error: 'Version not found' };
  }

  const version = versionData as PropertyVersion;

  // Verify the actor is the property owner or an admin — callers are
  // responsible for role-checking, but we double-check owner access here.
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('*')
    .eq('id', propertyId)
    .single();

  if (propError || !property) {
    return { success: false, error: 'Property not found' };
  }

  const currentProperty = property as Property;

  if (currentProperty.owner_id !== actorId) {
    return { success: false, error: 'Forbidden: only the property owner may roll back a version', statusCode: 403 };
  }

  // Apply the snapshot as an update (this will trigger a new version record).
  const restorePayload = version.snapshot as Partial<Property>;
  const updateResult = await updateProperty(propertyId, restorePayload, actorId, 'rollback',
    `Rolled back to version ${version.version_number} (id: ${versionId})`);

  return updateResult;
}
