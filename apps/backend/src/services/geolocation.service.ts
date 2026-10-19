/**
 * Geolocation service — handles property geocoding, validation, and metadata tracking.
 * Supports batch geocoding with rate limiting and confidence scoring.
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import { checkCoordinates, isRetryableGeocodingFailure } from '../utils/geolocationStatus.js';

export interface GeocodingResult {
  latitude: number;
  longitude: number;
  provider: string;
  confidence: number;
  formattedAddress: string;
}

export interface GeocodingBatchResult {
  totalProperties: number;
  successCount: number;
  failureCount: number;
  lowConfidenceCount: number;
  errors: string[];
}

const CONFIDENCE_THRESHOLD = 0.7; // Flag for review if below this
const RATE_LIMIT_MS = 500; // Delay between requests to avoid API throttling
const BATCH_SIZE = 50; // Process in batches to manage memory
const GEOCODE_MAX_ATTEMPTS = 3; // Transient geocoder failures are retried with backoff
const GEOCODE_RETRY_BASE_MS = 1000;

export interface GeocodingBatchOptions {
  /** When true, geocode and report results without writing to the database. */
  dryRun?: boolean;
}

/**
 * Normalize address components by removing extra whitespace and standardizing format.
 */
function normalizeAddress(
  address: string,
  city?: string,
  country?: string,
): string {
  const parts = [address, city, country]
    .filter(Boolean)
    .map((p) => p?.trim().replace(/\s+/g, ' '))
    .filter(Boolean);

  return parts.join(', ');
}

/**
 * Rate-limited geocoding using OpenStreetMap Nominatim API (free, no key required).
 * Returns null if geocoding fails; clients should handle and retry.
 */
async function geocodeAddress(address: string): Promise<GeocodingResult | null> {
  for (let attempt = 1; attempt <= GEOCODE_MAX_ATTEMPTS; attempt++) {
    const params = new URLSearchParams({
      q: address,
      format: 'json',
      limit: '1',
    });

    let failure: number | 'network';
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { 'User-Agent': 'Rentars/1.0' },
      });

      if (response.ok) {
        return parseNominatimResponse(await response.json());
      }
      console.error(`Nominatim API error: ${response.status}`);
      failure = response.status;
    } catch (error) {
      console.error('Geocoding error:', error);
      failure = 'network';
    }

    if (!isRetryableGeocodingFailure(failure) || attempt === GEOCODE_MAX_ATTEMPTS) {
      return null;
    }
    await delay(GEOCODE_RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  return null;
}

/**
 * Convert a Nominatim search response into a geocoding result. Returns null for
 * empty or unparseable responses, and for coordinates that fail validation, so
 * an invalid point is never written to a listing.
 */
function parseNominatimResponse(body: unknown): GeocodingResult | null {
  const results = Array.isArray(body) ? (body as Array<{
    lat: string;
    lon: string;
    display_name: string;
    importance: number;
  }>) : [];

  if (results.length === 0) return null;

  const result = results[0];
  const latitude = parseFloat(result.lat);
  const longitude = parseFloat(result.lon);
  if (!checkCoordinates(latitude, longitude).valid) return null;

  return {
    latitude,
    longitude,
    provider: 'nominatim',
    confidence: result.importance ?? 0.5,
    formattedAddress: result.display_name,
  };
}

/**
 * Delay execution for rate limiting.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Geocode all properties with pending status or missing coordinates.
 * Processes in batches with rate limiting.
 * Returns summary of results including error list.
 */
export async function geocodePropertiesBatch(
  options: GeocodingBatchOptions = {},
): Promise<ServiceResponse<GeocodingBatchResult>> {
  const dryRun = options.dryRun === true;
  const result: GeocodingBatchResult = {
    totalProperties: 0,
    successCount: 0,
    failureCount: 0,
    lowConfidenceCount: 0,
    errors: [],
  };

  try {
    // Fetch all properties that need geocoding. Failed rows are included so a
    // transient geocoder outage is retried on the next run.
    const { data: properties, error } = await supabase
      .from('properties')
      .select('id, address, city, country, latitude, longitude, geocoding_status')
      .or('geocoding_status.in.(pending,failed),latitude.is.null');

    if (error) {
      result.errors.push(`Failed to fetch properties: ${error.message}`);
      return { success: false, error: error.message, data: result };
    }

    const propsToGeocode = properties || [];
    result.totalProperties = propsToGeocode.length;

    if (propsToGeocode.length === 0) {
      return { success: true, data: result };
    }

    // Process in batches with rate limiting
    for (let i = 0; i < propsToGeocode.length; i += BATCH_SIZE) {
      const batch = propsToGeocode.slice(i, Math.min(i + BATCH_SIZE, propsToGeocode.length));

      for (const prop of batch) {
        await delay(RATE_LIMIT_MS);

        const normalizedAddress = normalizeAddress(
          prop.address || '',
          prop.city,
          prop.country,
        );

        if (!normalizedAddress) {
          result.failureCount++;
          result.errors.push(`Property ${prop.id}: No address to geocode`);
          continue;
        }

        const geocoded = await geocodeAddress(normalizedAddress);

        if (!geocoded) {
          result.failureCount++;
          result.errors.push(`Property ${prop.id}: Geocoding failed for ${normalizedAddress}`);

          // Update status to failed so the next run retries this listing
          if (!dryRun) await supabase
            .from('properties')
            .update({
              geocoding_status: 'failed',
              geocoding_notes: `Failed to geocode: ${normalizedAddress}`,
            })
            .eq('id', prop.id);

          continue;
        }

        // Check confidence threshold
        const requiresReview = geocoded.confidence < CONFIDENCE_THRESHOLD;
        if (requiresReview) {
          result.lowConfidenceCount++;
        }

        if (dryRun) {
          result.successCount++;
          continue;
        }

        // Update property with geocoded data
        const { error: updateError } = await supabase
          .from('properties')
          .update({
            latitude: geocoded.latitude,
            longitude: geocoded.longitude,
            geocoding_provider: geocoded.provider,
            geocoding_confidence: geocoded.confidence,
            geocoding_source_address: normalizedAddress,
            geocoding_processed_at: new Date().toISOString(),
            geocoding_original_address: prop.address,
            requires_geocoding_review: requiresReview,
            geocoding_status: 'completed',
          })
          .eq('id', prop.id);

        if (updateError) {
          result.failureCount++;
          result.errors.push(`Property ${prop.id}: Failed to update coordinates - ${updateError.message}`);
        } else {
          result.successCount++;
        }
      }
    }

    return { success: true, data: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    result.errors.push(`Batch geocoding error: ${message}`);
    return { success: false, error: message, data: result };
  }
}

/**
 * Validate and correct geocoding for a single property.
 * Used by hosts to review and correct low-confidence geocoding results.
 */
export async function validateGeolocation(
  propertyId: string,
  latitude: number,
  longitude: number,
  reason?: string,
): Promise<ServiceResponse<null>> {
  try {
    const check = checkCoordinates(latitude, longitude);
    if (!check.valid) {
      return { success: false, error: check.reason ?? 'Invalid coordinates' };
    }

    // Get current property to log correction
    const { data: prop } = await supabase
      .from('properties')
      .select('latitude, longitude')
      .eq('id', propertyId)
      .single();

    // Log correction if coordinates changed
    if (prop && (prop.latitude !== latitude || prop.longitude !== longitude)) {
      await supabase
        .from('geocoding_corrections')
        .insert({
          property_id: propertyId,
          original_latitude: prop.latitude,
          original_longitude: prop.longitude,
          corrected_latitude: latitude,
          corrected_longitude: longitude,
          correction_reason: reason,
        });
    }

    // Update property
    const { error } = await supabase
      .from('properties')
      .update({
        latitude,
        longitude,
        requires_geocoding_review: false,
        geocoding_status: 'verified',
      })
      .eq('id', propertyId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Get properties that require geocoding review (low confidence results).
 */
export async function getPropertiesRequiringGeolocationReview(limit = 50): Promise<
  ServiceResponse<
    Array<{
      id: string;
      title: string;
      address: string;
      city: string;
      country: string;
      latitude: number;
      longitude: number;
      geocoding_confidence: number;
    }>
  >
> {
  try {
    const { data, error } = await supabase
      .from('properties')
      .select('id, title, address, city, country, latitude, longitude, geocoding_confidence')
      .eq('requires_geocoding_review', true)
      .limit(limit);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, data: data || [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Get geocoding statistics for monitoring.
 */
export async function getGeocodingStats(): Promise<
  ServiceResponse<{
    total: number;
    geocoded: number;
    pending: number;
    failed: number;
    requiresReview: number;
    averageConfidence: number;
  }>
> {
  try {
    const [totalResult, geocodedResult, pendingResult, failedResult, reviewResult, confidenceResult] =
      await Promise.all([
        supabase.from('properties').select('id', { count: 'exact', head: true }),
        supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('geocoding_status', 'completed'),
        supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('geocoding_status', 'pending'),
        supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('geocoding_status', 'failed'),
        supabase
          .from('properties')
          .select('id', { count: 'exact', head: true })
          .eq('requires_geocoding_review', true),
        supabase
          .from('properties')
          .select('geocoding_confidence', { count: 'exact', head: true })
          .not('geocoding_confidence', 'is', null),
      ]);

    const total = totalResult.count ?? 0;
    const geocoded = geocodedResult.count ?? 0;
    const pending = pendingResult.count ?? 0;
    const failed = failedResult.count ?? 0;
    const requiresReview = reviewResult.count ?? 0;

    // Calculate average confidence if we have confidence data
    let averageConfidence = 0;
    if (confidenceResult.data && confidenceResult.data.length > 0) {
      const confidences = confidenceResult.data
        .map((r) => r.geocoding_confidence)
        .filter((c) => c != null);
      if (confidences.length > 0) {
        averageConfidence =
          confidences.reduce((a, b) => a + b, 0) / confidences.length;
      }
    }

    return {
      success: true,
      data: {
        total,
        geocoded,
        pending,
        failed,
        requiresReview,
        averageConfidence: Math.round(averageConfidence * 100) / 100,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
