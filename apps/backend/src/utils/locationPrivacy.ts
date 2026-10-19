/**
 * Location privacy utilities.
 *
 * Three precision tiers control what coordinates are returned per viewer:
 *
 *   public   — Anonymous visitors, search results, and unauthenticated calls.
 *              Coordinates are snapped to a ~500 m grid with a deterministic
 *              jitter.  Exact lat/lng are never exposed.
 *
 *   booking  — A tenant whose booking for this property is Pending OR Confirmed.
 *              Exact coordinates are revealed so they can navigate to the
 *              property for their upcoming or active stay.
 *
 *   host     — The property owner (host) or a platform admin.
 *              Always receives exact coordinates.
 *
 * Tiers are evaluated in the controller via viewerHasExactLocationAccess and
 * enforced by redactExactCoordinates / toApproximateLocation.
 * Logs and data-exports must never include exact coordinates for public-tier
 * viewers; strip them before writing to any external sink.
 */

/** Approximate radius shown on public map, in metres */
export const PUBLIC_LOCATION_RADIUS_M = 500;

/** Location precision tier assigned to a viewer. */
export type LocationPrecisionTier = 'public' | 'booking' | 'host';

/**
 * Snap a coordinate to a ~500 m grid and apply a small deterministic offset
 * to prevent exact recovery of the original value.
 *
 * The offset is derived from the coordinate itself (deterministic per
 * property so the circle centre is stable across page loads) but stays
 * within ±(GRID / 2) so viewers cannot reverse-engineer the exact location.
 *
 * ~0.005° ≈ 500 m at most latitudes.
 */
const GRID_DEGREES = 0.005; // ~500 m

export function approximateCoordinate(value: number): number {
  // Round to nearest grid point
  const snapped = Math.round(value / GRID_DEGREES) * GRID_DEGREES;
  // Add a small deterministic sub-grid jitter based on the snapped value
  // to prevent two nearby snapped points colliding.
  const jitter = ((Math.sin(snapped * 1000) + 1) / 2) * GRID_DEGREES * 0.4 - GRID_DEGREES * 0.2;
  return Math.round((snapped + jitter) * 1_000_000) / 1_000_000;
}

export interface ExactLocation {
  latitude: number;
  longitude: number;
}

export interface ApproximateLocation {
  approximate_latitude: number;
  approximate_longitude: number;
  /** Radius of the uncertainty circle shown on the map, in metres */
  location_radius_m: number;
}

/**
 * Compute the public (obfuscated) location from exact coordinates.
 */
export function toApproximateLocation(exact: ExactLocation): ApproximateLocation {
  return {
    approximate_latitude: approximateCoordinate(exact.latitude),
    approximate_longitude: approximateCoordinate(exact.longitude),
    location_radius_m: PUBLIC_LOCATION_RADIUS_M,
  };
}

/**
 * Redact exact lat/lng from a property object and replace with approximate
 * coordinates. The exact `latitude` and `longitude` fields are removed.
 */
export function redactExactCoordinates<
  T extends { latitude?: number | null; longitude?: number | null },
>(property: T): Omit<T, 'latitude' | 'longitude'> & ApproximateLocation & { latitude: undefined; longitude: undefined } {
  const { latitude, longitude, ...rest } = property;

  if (typeof latitude === 'number' && typeof longitude === 'number') {
    const approx = toApproximateLocation({ latitude, longitude });
    return {
      ...(rest as Omit<T, 'latitude' | 'longitude'>),
      ...approx,
      latitude: undefined,
      longitude: undefined,
    };
  }

  // No coordinates stored — return as-is with empty approximation
  return {
    ...(rest as Omit<T, 'latitude' | 'longitude'>),
    approximate_latitude: 0,
    approximate_longitude: 0,
    location_radius_m: PUBLIC_LOCATION_RADIUS_M,
    latitude: undefined,
    longitude: undefined,
  };
}
