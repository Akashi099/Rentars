-- Migration 00066: Nearby search only returns listings with trusted positions (issue #748)
--
-- Listings whose geocoding is pending, failed, unknown or flagged for host review
-- must not appear in nearby results, because the distance shown to a guest would
-- be computed from an unreliable point. Rules mirror isNearbyEligible() in
-- apps/backend/src/utils/geolocationStatus.ts.

CREATE OR REPLACE FUNCTION search_nearby_properties(
  lat DECIMAL,
  lng DECIMAL,
  radius_km INTEGER DEFAULT 50
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  price_per_night DECIMAL,
  city TEXT,
  country TEXT,
  bedrooms INTEGER,
  amenities TEXT[],
  distance_km DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id,
    p.title,
    p.price_per_night,
    p.city,
    p.country,
    p.bedrooms,
    p.amenities,
    ROUND(ST_DistanceSphere(
      ST_Point(lng, lat)::geography,
      p.location
    ) / 1000)::DECIMAL AS distance_km
  FROM properties p
  WHERE p.status = 'available'
    AND p.location IS NOT NULL
    AND p.geocoding_status IN ('verified', 'completed')
    AND COALESCE(p.requires_geocoding_review, FALSE) = FALSE
    AND ST_DWithin(p.location, ST_Point(lng, lat)::geography, radius_km * 1000)
  ORDER BY distance_km ASC, p.id ASC;
END;
$$ LANGUAGE plpgsql;
