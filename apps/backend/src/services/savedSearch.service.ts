import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { Property } from './property.service.js';
import {
  buildSavedSearchLink,
  isAlertDue,
  isWithinQuietHours,
  normalizeSavedSearchFilters,
  type DigestFrequency,
} from '../utils/savedSearchAlerts.js';

type DeliveryStatus = 'pending' | 'sent' | 'failed';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavedSearch {
  id: string;
  user_id: string;
  name: string;
  filters: Record<string, unknown>;
  is_paused?: boolean;
  digest_frequency?: 'immediate' | 'daily' | 'weekly';
  created_at?: string;
  updated_at?: string;
  version?: number;
  /** Normalisation rules that produced `filters`. */
  filter_version?: number;
  /** Link that reopens the search page with these filters applied. */
  share_url?: string;
}

/** Fields a user may change on an existing saved search. */
const UPDATABLE_FIELDS = ['name', 'filters', 'is_paused', 'digest_frequency'] as const;

/** Subset of AdvancedSearchFilters relevant for matching a new property. */
export interface SavedSearchFilters {
  query?: string;
  city?: string;
  country?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  min_bathrooms?: number;
  guests?: number;
  amenities?: string[];
  property_types?: string[];
  checkIn?: string;
  checkOut?: string;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createSavedSearch(
  userId: string,
  name: string,
  filters: Record<string, unknown>,
): Promise<ServiceResponse<SavedSearch>> {
  if (!name || name.trim().length === 0) {
    return { success: false, error: 'Search name is required' };
  }

  const normalized = normalizeSavedSearchFilters(filters);
  const { data, error } = await supabase
    .from('saved_searches')
    .insert({
      user_id: userId,
      name: name.trim(),
      filters: normalized.filters,
      filter_version: normalized.version,
    })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: withShareUrl(data as SavedSearch) };
}

export async function listSavedSearches(
  userId: string,
): Promise<ServiceResponse<SavedSearch[]>> {
  const { data, error } = await supabase
    .from('saved_searches')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []).map((row) => withShareUrl(row as SavedSearch)) };
}

/**
 * Update one of the user's saved searches. Only the fields in UPDATABLE_FIELDS
 * are written, so a request cannot reassign ownership or change bookkeeping
 * columns. Filters are normalised and versioned the same way as on create.
 */
export async function updateSavedSearch(
  userId: string,
  searchId: string,
  updates: Partial<SavedSearch>,
): Promise<ServiceResponse<SavedSearch>> {
  const writable: Record<string, unknown> = {};
  for (const key of UPDATABLE_FIELDS) {
    if (updates[key] !== undefined) writable[key] = updates[key];
  }

  if (writable.name !== undefined) {
    const name = String(writable.name).trim();
    if (name.length === 0) return { success: false, error: 'Search name is required' };
    writable.name = name;
  }

  if (writable.filters !== undefined) {
    const normalized = normalizeSavedSearchFilters(writable.filters as Record<string, unknown>);
    writable.filters = normalized.filters;
    writable.filter_version = normalized.version;
  }

  if (Object.keys(writable).length === 0) {
    return { success: false, error: 'At least one updatable field is required' };
  }

  const { data, error } = await supabase
    .from('saved_searches')
    .update(writable)
    .eq('id', searchId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: withShareUrl(data as SavedSearch) };
}

/** Attach a share link built from the saved, normalised filters. */
function withShareUrl(search: SavedSearch): SavedSearch {
  const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
  const filters = (search.filters ?? {}) as Record<string, unknown>;
  return { ...search, share_url: buildSavedSearchLink(baseUrl, filters) };
}

export async function pauseSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<SavedSearch>> {
  return updateSavedSearch(userId, searchId, { is_paused: true });
}

export async function resumeSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<SavedSearch>> {
  return updateSavedSearch(userId, searchId, { is_paused: false });
}

export async function updateDigestFrequency(
  userId: string,
  searchId: string,
  frequency: 'immediate' | 'daily' | 'weekly',
): Promise<ServiceResponse<SavedSearch>> {
  if (!['immediate', 'daily', 'weekly'].includes(frequency)) {
    return { success: false, error: 'Invalid digest frequency' };
  }
  return updateSavedSearch(userId, searchId, { digest_frequency: frequency });
}

export async function deleteSavedSearch(
  userId: string,
  searchId: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('saved_searches')
    .delete()
    .eq('id', searchId)
    .eq('user_id', userId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Matcher ──────────────────────────────────────────────────────────────────

/**
 * Synchronous portion of the matcher: evaluates all filters except dates.
 * Exported separately so unit tests can cover filter logic without DB calls.
 */
export function matchesSavedSearchSync(
  property: Pick<Property, 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
  filters: SavedSearchFilters,
): boolean {
  // Price range
  if (filters.min_price !== undefined && property.price_per_night != null) {
    if (property.price_per_night < filters.min_price) return false;
  }
  if (filters.max_price !== undefined && property.price_per_night != null) {
    if (property.price_per_night > filters.max_price) return false;
  }

  // City (case-insensitive partial match)
  if (filters.city && property.city) {
    if (!property.city.toLowerCase().includes(filters.city.toLowerCase())) return false;
  }

  // Country (case-insensitive partial match)
  if (filters.country && property.country) {
    if (!property.country.toLowerCase().includes(filters.country.toLowerCase())) return false;
  }

  // Bedrooms (minimum)
  if (filters.bedrooms !== undefined && property.bedrooms != null) {
    if (property.bedrooms < filters.bedrooms) return false;
  }

  // Bathrooms (minimum)
  if (filters.min_bathrooms !== undefined && property.bathrooms != null) {
    if (property.bathrooms < filters.min_bathrooms) return false;
  }

  // Guest capacity (minimum)
  if (filters.guests !== undefined && property.max_guests != null) {
    if (property.max_guests < filters.guests) return false;
  }

  // Property type (set membership — OR)
  if (filters.property_types && filters.property_types.length > 0 && property.property_type) {
    if (!filters.property_types.includes(property.property_type)) return false;
  }

  // Amenities (property must have ALL requested amenities)
  if (filters.amenities && filters.amenities.length > 0 && property.amenities) {
    const propAmenities = new Set(property.amenities.map((a) => a.toLowerCase()));
    for (const required of filters.amenities) {
      if (!propAmenities.has(required.toLowerCase())) return false;
    }
  }

  // Text query (title match — simple case-insensitive contains)
  if (filters.query && filters.query.trim().length > 0) {
    const q = filters.query.toLowerCase();
    const title = (property.title ?? '').toLowerCase();
    if (!title.includes(q)) return false;
  }

  return true;
}

/**
 * Check whether a property has blocked availability ranges overlapping the
 * requested date window. Uses the same overlap inequality as advancedSearch:
 *   start_date < checkOut AND end_date > checkIn
 *
 * For a newly published property there should be no bookings yet, but the
 * host may have pre-blocked dates via availability_ranges.
 */
async function isPropertyAvailableForDates(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('availability_ranges')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_available', false)
    .lt('start_date', checkOut)
    .gt('end_date', checkIn)
    .limit(1);

  return !data || data.length === 0;
}

/**
 * Full matcher: sync filter checks + async date-range availability check.
 * When checkIn/checkOut are absent from filters, behaves like the sync version.
 */
export async function matchesSavedSearch(
  property: Pick<Property, 'id' | 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
  filters: SavedSearchFilters,
): Promise<boolean> {
  if (!matchesSavedSearchSync(property, filters)) return false;

  // Date-range availability check: verify the property isn't blocked for the
  // requested dates. Only runs when both checkIn and checkOut are provided.
  if (filters.checkIn && filters.checkOut && property.id) {
    const available = await isPropertyAvailableForDates(property.id, filters.checkIn, filters.checkOut);
    if (!available) return false;
  }

  return true;
}

// ─── Notification fan-out ─────────────────────────────────────────────────────

/**
 * Find all saved searches that match a newly listed property and send
 * notifications to their owners. Fire-and-forget: notification failures
 * never throw.
 *
 * Delivery rules (issue #751):
 * - Paused and deleted searches never match, because they are filtered out here.
 * - Each (search, listing) pair is recorded once in `saved_search_alert_deliveries`,
 *   so a listing is never alerted twice for the same search.
 * - A search with a daily or weekly frequency is alerted only when its window
 *   has elapsed since its last sent alert. Quiet hours hold alerts the same way.
 *   Held deliveries stay `pending` and go out on a later matching run.
 *
 * @returns The number of users notified.
 */
export async function notifyMatchingSavedSearches(
  property: Pick<Property, 'id' | 'title' | 'city' | 'country' | 'price_per_night' | 'bedrooms' | 'bathrooms' | 'max_guests' | 'amenities' | 'property_type'>,
  now: Date = new Date(),
): Promise<ServiceResponse<number>> {
  // Fetch all saved searches that are not paused
  const { data: searches, error } = await supabase
    .from('saved_searches')
    .select('id, user_id, name, filters, is_paused, digest_frequency')
    .eq('is_paused', false);

  if (error) return { success: false, error: error.message };

  const allSearches = (searches ?? []) as SavedSearch[];
  const matching: SavedSearch[] = [];

  for (const s of allSearches) {
    const isMatch = await matchesSavedSearch(property, s.filters as SavedSearchFilters);
    if (isMatch) matching.push(s);
  }

  if (matching.length === 0) return { success: true, data: 0 };

  // Group by user; quiet hours are a per-user preference.
  const searchesByUser = new Map<string, SavedSearch[]>();
  for (const search of matching) {
    if (!searchesByUser.has(search.user_id)) {
      searchesByUser.set(search.user_id, []);
    }
    searchesByUser.get(search.user_id)!.push(search);
  }

  let notified = 0;
  const { createNotification } = await import('./notification.service.js');

  for (const [userId, userSearches] of searchesByUser.entries()) {
    try {
      const quiet = await getQuietHours(userId);
      if (isWithinQuietHours(now, quiet.start, quiet.end)) {
        for (const search of userSearches) {
          await ensureDelivery(userId, search.id, property.id);
        }
        continue;
      }

      // Only searches that have not already handled this listing and whose
      // frequency window is open are delivered now.
      const dueSearches: SavedSearch[] = [];
      for (const search of userSearches) {
        const status = await ensureDelivery(userId, search.id, property.id);
        if (status !== 'pending') continue;

        const frequency = (search.digest_frequency || 'immediate') as DigestFrequency;
        const lastSentAt = frequency === 'immediate' ? null : await getLastSentAlertAt(search.id);
        if (isAlertDue(frequency, lastSentAt, now)) {
          dueSearches.push(search);
        }
      }

      if (dueSearches.length === 0) continue;

      const lastSearch = dueSearches[0];
      const result = await createNotification(userId, 'new_property_search', {
        propertyId: property.id,
        propertyTitle: property.title,
        savedSearchName: lastSearch.name,
        message: `A new listing "${property.title}" matches your saved search "${lastSearch.name}".`,
        matchCount: dueSearches.length,
        digestFrequency: lastSearch.digest_frequency || 'immediate',
      });

      await markDeliveries(
        dueSearches.map((s) => s.id),
        property.id,
        result.success ? 'sent' : 'failed',
        now,
      );
      if (result.success) notified++;
    } catch {
      // Notification failure must never block property creation
    }
  }

  return { success: true, data: notified };
}

async function getQuietHours(userId: string): Promise<{ start: string | null; end: string | null }> {
  const { data } = await supabase
    .from('notification_preferences')
    .select('quiet_hours_start, quiet_hours_end')
    .eq('user_id', userId)
    .maybeSingle();

  return {
    start: (data?.quiet_hours_start as string | null | undefined) ?? null,
    end: (data?.quiet_hours_end as string | null | undefined) ?? null,
  };
}

/**
 * Ensure a delivery row exists for (search, listing) and return its status.
 * An existing 'pending' row is returned as-is so a held alert can still go out;
 * 'sent' or 'failed' means this search has already handled the listing.
 */
async function ensureDelivery(
  userId: string,
  searchId: string,
  propertyId: string,
): Promise<DeliveryStatus> {
  await supabase
    .from('saved_search_alert_deliveries')
    .upsert(
      { saved_search_id: searchId, property_id: propertyId, user_id: userId, status: 'pending' },
      { onConflict: 'saved_search_id,property_id', ignoreDuplicates: true },
    );

  const { data } = await supabase
    .from('saved_search_alert_deliveries')
    .select('status')
    .eq('saved_search_id', searchId)
    .eq('property_id', propertyId)
    .maybeSingle();

  return (data?.status as DeliveryStatus | undefined) ?? 'pending';
}

async function getLastSentAlertAt(searchId: string): Promise<Date | null> {
  const { data } = await supabase
    .from('saved_search_alert_deliveries')
    .select('sent_at')
    .eq('saved_search_id', searchId)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1);

  const sentAt = (data?.[0] as { sent_at?: string } | undefined)?.sent_at;
  return sentAt ? new Date(sentAt) : null;
}

async function markDeliveries(
  searchIds: string[],
  propertyId: string,
  status: 'sent' | 'failed',
  now: Date,
): Promise<void> {
  await supabase
    .from('saved_search_alert_deliveries')
    .update({ status, sent_at: status === 'sent' ? now.toISOString() : null })
    .in('saved_search_id', searchIds)
    .eq('property_id', propertyId);
}
