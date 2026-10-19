/**
 * Geolocation status rules for listings (issue #748).
 *
 * Every listing resolves to exactly one explicit status so that nearby search,
 * the host review queue and public responses never have to guess whether a
 * position is trustworthy.
 */

export const GEOLOCATION_STATUSES = [
  'verified',
  'completed',
  'needs_review',
  'pending',
  'failed',
  'unknown',
] as const;

export type GeolocationStatus = (typeof GEOLOCATION_STATUSES)[number];

/** Statuses whose coordinates may be used for nearby search results. */
const NEARBY_ELIGIBLE: ReadonlySet<GeolocationStatus> = new Set(['verified', 'completed']);

/**
 * Decimal places kept for coordinates in public responses. Two decimal places
 * is roughly 1.1 km of precision, which is enough to show a neighbourhood but
 * not an exact residential address.
 */
export const PUBLIC_COORDINATE_DECIMALS = 2;

export interface CoordinateCheck {
  valid: boolean;
  reason?: string;
}

export interface GeolocationRow {
  latitude?: number | string | null;
  longitude?: number | string | null;
  geocoding_status?: string | null;
  requires_geocoding_review?: boolean | null;
}

/**
 * Validate a latitude/longitude pair. Accepts numbers or numeric strings
 * (database DECIMAL columns come back as strings), rejects anything non-finite
 * or out of range, and rejects the exact (0, 0) point, which is almost always a
 * placeholder written by a failed import rather than a real listing location.
 */
export function checkCoordinates(latitude: unknown, longitude: unknown): CoordinateCheck {
  const lat = toNumber(latitude);
  const lng = toNumber(longitude);

  if (lat === null || lng === null) {
    return { valid: false, reason: 'Coordinates must be numeric' };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, reason: 'Latitude must be between -90 and 90' };
  }
  if (lng < -180 || lng > 180) {
    return { valid: false, reason: 'Longitude must be between -180 and 180' };
  }
  if (lat === 0 && lng === 0) {
    return { valid: false, reason: 'Coordinates (0, 0) are a placeholder, not a location' };
  }
  return { valid: true };
}

/**
 * Resolve the explicit geolocation status for a listing row.
 *
 * Precedence:
 * 1. Invalid or missing coordinates → `failed` / `pending` if the geocoder
 *    recorded that state, otherwise `unknown`.
 * 2. Valid coordinates flagged for review → `needs_review`.
 * 3. Otherwise the stored status, if it is one we recognise, else `unknown`.
 */
export function resolveGeolocationStatus(row: GeolocationRow): GeolocationStatus {
  const stored = row.geocoding_status ?? null;
  const hasValidCoordinates = checkCoordinates(row.latitude, row.longitude).valid;

  if (!hasValidCoordinates) {
    if (stored === 'failed') return 'failed';
    if (stored === 'pending') return 'pending';
    return 'unknown';
  }

  if (row.requires_geocoding_review) return 'needs_review';

  if (stored === 'verified' || stored === 'completed') return stored;
  return 'unknown';
}

/**
 * Whether a listing with this status may appear in nearby search. Unknown,
 * pending, failed and low-confidence positions are excluded so the distance
 * shown to a guest is never computed from an unreliable point.
 */
export function isNearbyEligible(status: GeolocationStatus): boolean {
  return NEARBY_ELIGIBLE.has(status);
}

/**
 * Round coordinates for a public response. Exact residential coordinates must
 * not leak; callers that need exact positions (hosts, admins) should not use
 * this helper.
 */
export function roundPublicCoordinates(
  latitude: number,
  longitude: number,
  decimals = PUBLIC_COORDINATE_DECIMALS
): { latitude: number; longitude: number } {
  const factor = 10 ** decimals;
  return {
    latitude: Math.round(latitude * factor) / factor,
    longitude: Math.round(longitude * factor) / factor,
  };
}

/**
 * Whether a failed geocoder call should be retried. Rate limiting, server
 * errors and network failures are transient; other client errors (for example
 * a malformed request) will not succeed on retry.
 */
export function isRetryableGeocodingFailure(httpStatus: number | 'network'): boolean {
  if (httpStatus === 'network') return true;
  return httpStatus === 429 || httpStatus >= 500;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
