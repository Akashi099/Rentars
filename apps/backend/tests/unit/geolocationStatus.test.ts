/**
 * Unit tests for listing geolocation status rules (issue #748).
 */

import { describe, expect, it } from 'bun:test';
import {
  GEOLOCATION_STATUSES,
  checkCoordinates,
  isNearbyEligible,
  isRetryableGeocodingFailure,
  resolveGeolocationStatus,
  roundPublicCoordinates,
} from '../../src/utils/geolocationStatus.js';

describe('checkCoordinates', () => {
  it('accepts a valid numeric pair', () => {
    expect(checkCoordinates(6.5244, 3.3792)).toEqual({ valid: true });
  });

  it('accepts numeric strings as returned by DECIMAL columns', () => {
    expect(checkCoordinates('6.5244000', '3.3792000').valid).toBe(true);
  });

  it('rejects missing, empty and non-numeric values', () => {
    expect(checkCoordinates(null, 3).valid).toBe(false);
    expect(checkCoordinates(undefined, 3).valid).toBe(false);
    expect(checkCoordinates('', 3).valid).toBe(false);
    expect(checkCoordinates('abc', 3).valid).toBe(false);
    expect(checkCoordinates(Number.NaN, 3).valid).toBe(false);
    expect(checkCoordinates(Number.POSITIVE_INFINITY, 3).valid).toBe(false);
  });

  it('rejects latitude and longitude outside their ranges', () => {
    expect(checkCoordinates(90.01, 0).valid).toBe(false);
    expect(checkCoordinates(-90.01, 10).valid).toBe(false);
    expect(checkCoordinates(10, 180.01).valid).toBe(false);
    expect(checkCoordinates(10, -180.01).valid).toBe(false);
  });

  it('accepts the exact boundaries of the valid ranges', () => {
    expect(checkCoordinates(90, 180).valid).toBe(true);
    expect(checkCoordinates(-90, -180).valid).toBe(true);
  });

  it('rejects the (0, 0) placeholder point', () => {
    const result = checkCoordinates(0, 0);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('placeholder');
  });

  it('still accepts a zero coordinate when the other axis is non-zero', () => {
    expect(checkCoordinates(0, 10).valid).toBe(true);
  });
});

describe('resolveGeolocationStatus', () => {
  it('returns verified and completed for valid coordinates with those statuses', () => {
    expect(
      resolveGeolocationStatus({ latitude: 1, longitude: 2, geocoding_status: 'verified' })
    ).toBe('verified');
    expect(
      resolveGeolocationStatus({ latitude: 1, longitude: 2, geocoding_status: 'completed' })
    ).toBe('completed');
  });

  it('returns needs_review when the review flag is set, even if coordinates exist', () => {
    expect(
      resolveGeolocationStatus({
        latitude: 1,
        longitude: 2,
        geocoding_status: 'completed',
        requires_geocoding_review: true,
      })
    ).toBe('needs_review');
  });

  it('reports failed and pending for invalid coordinates when the geocoder recorded that state', () => {
    expect(
      resolveGeolocationStatus({ latitude: null, longitude: null, geocoding_status: 'failed' })
    ).toBe('failed');
    expect(
      resolveGeolocationStatus({ latitude: 0, longitude: 0, geocoding_status: 'pending' })
    ).toBe('pending');
  });

  it('reports unknown for invalid coordinates with no recorded geocoding state', () => {
    expect(resolveGeolocationStatus({})).toBe('unknown');
    expect(
      resolveGeolocationStatus({ latitude: 200, longitude: 2, geocoding_status: 'completed' })
    ).toBe('unknown');
  });

  it('reports unknown for valid coordinates with an unrecognised status', () => {
    expect(
      resolveGeolocationStatus({ latitude: 1, longitude: 2, geocoding_status: 'legacy' })
    ).toBe('unknown');
    expect(resolveGeolocationStatus({ latitude: 1, longitude: 2 })).toBe('unknown');
  });

  it('always returns one of the declared statuses', () => {
    const samples = [
      {},
      { latitude: 1, longitude: 2, geocoding_status: 'verified' },
      { latitude: null, longitude: null, geocoding_status: 'failed' },
      { latitude: 1, longitude: 2, requires_geocoding_review: true },
    ];
    for (const sample of samples) {
      expect(GEOLOCATION_STATUSES).toContain(resolveGeolocationStatus(sample));
    }
  });
});

describe('isNearbyEligible', () => {
  it('admits only verified and completed positions', () => {
    expect(isNearbyEligible('verified')).toBe(true);
    expect(isNearbyEligible('completed')).toBe(true);
    expect(isNearbyEligible('needs_review')).toBe(false);
    expect(isNearbyEligible('pending')).toBe(false);
    expect(isNearbyEligible('failed')).toBe(false);
    expect(isNearbyEligible('unknown')).toBe(false);
  });
});

describe('roundPublicCoordinates', () => {
  it('rounds to two decimal places by default', () => {
    expect(roundPublicCoordinates(6.524412, 3.379206)).toEqual({ latitude: 6.52, longitude: 3.38 });
  });

  it('rounds negative coordinates to the nearest two-decimal value', () => {
    expect(roundPublicCoordinates(-33.868819, -151.209296)).toEqual({
      latitude: -33.87,
      longitude: -151.21,
    });
  });

  it('respects an explicit precision', () => {
    expect(roundPublicCoordinates(6.524412, 3.379206, 3)).toEqual({
      latitude: 6.524,
      longitude: 3.379,
    });
  });

  it('never returns more precision than requested for a set of exact inputs', () => {
    const exact = { latitude: 6.5244123456, longitude: 3.3792061234 };
    const rounded = roundPublicCoordinates(exact.latitude, exact.longitude);
    expect(rounded.latitude.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    expect(rounded.longitude.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
  });
});

describe('isRetryableGeocodingFailure', () => {
  it('retries rate limits, server errors and network failures', () => {
    expect(isRetryableGeocodingFailure(429)).toBe(true);
    expect(isRetryableGeocodingFailure(500)).toBe(true);
    expect(isRetryableGeocodingFailure(503)).toBe(true);
    expect(isRetryableGeocodingFailure('network')).toBe(true);
  });

  it('does not retry client errors that will not succeed on a second attempt', () => {
    expect(isRetryableGeocodingFailure(400)).toBe(false);
    expect(isRetryableGeocodingFailure(403)).toBe(false);
    expect(isRetryableGeocodingFailure(404)).toBe(false);
  });
});
