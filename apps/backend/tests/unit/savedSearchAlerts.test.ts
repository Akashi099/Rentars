/**
 * Unit tests for saved-search normalisation, links and alert timing (issue #751).
 */

import { describe, expect, it } from 'bun:test';
import {
  SAVED_SEARCH_FILTER_VERSION,
  buildSavedSearchLink,
  decodeSavedSearchParams,
  encodeSavedSearchParams,
  isAlertDue,
  isWithinQuietHours,
  normalizeSavedSearchFilters,
} from '../../src/utils/savedSearchAlerts.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('normalizeSavedSearchFilters', () => {
  it('produces the same canonical result for equivalent inputs', () => {
    const a = normalizeSavedSearchFilters({
      city: '  Lagos ',
      amenities: ['Pool', 'wifi', 'pool'],
      query: '  Beach   HOUSE ',
    });
    const b = normalizeSavedSearchFilters({
      query: 'beach house',
      amenities: ['wifi', 'POOL'],
      city: 'lagos',
    });
    expect(a).toEqual(b);
  });

  it('drops unknown keys, empty strings, empty lists and non-finite numbers', () => {
    const result = normalizeSavedSearchFilters({
      city: '   ',
      amenities: [],
      min_price: Number.NaN,
      max_price: 'not a number',
      bedrooms: 2,
      secret_internal_flag: true,
    });
    expect(result.filters).toEqual({ bedrooms: 2 });
  });

  it('accepts numeric strings for numeric filters', () => {
    expect(normalizeSavedSearchFilters({ min_price: '150' }).filters.min_price).toBe(150);
  });

  it('keeps only well-formed ISO dates', () => {
    const result = normalizeSavedSearchFilters({ checkIn: '2026-11-01', checkOut: '11/02/2026' });
    expect(result.filters.checkIn).toBe('2026-11-01');
    expect(result.filters.checkOut).toBeUndefined();
  });

  it('stamps the current filter version', () => {
    expect(normalizeSavedSearchFilters({}).version).toBe(SAVED_SEARCH_FILTER_VERSION);
  });
});

describe('saved-search links', () => {
  const raw = {
    query: 'Ocean View',
    city: 'Lagos',
    country: 'Nigeria',
    checkIn: '2026-11-01',
    checkOut: '2026-11-05',
    min_price: 50,
    max_price: 300,
    bedrooms: 2,
    guests: 4,
    amenities: ['wifi', 'pool, heated'],
    property_types: ['apartment'],
  };

  it('restores exactly the normalised filters that were saved', () => {
    const normalized = normalizeSavedSearchFilters(raw);
    const restored = decodeSavedSearchParams(encodeSavedSearchParams(normalized));
    expect(restored).toEqual(normalized);
  });

  it('keeps amenity values that contain commas intact', () => {
    const restored = decodeSavedSearchParams(
      encodeSavedSearchParams(normalizeSavedSearchFilters(raw))
    );
    expect(restored?.filters.amenities).toEqual(['pool, heated', 'wifi']);
  });

  it('round-trips through a full link', () => {
    const link = buildSavedSearchLink('https://rentars.app', raw);
    const url = new URL(link);
    expect(url.pathname).toBe('/search');
    const restored = decodeSavedSearchParams(url.searchParams);
    expect(restored).toEqual(normalizeSavedSearchFilters(raw));
  });

  it('refuses links from an unsupported filter version', () => {
    const params = new URLSearchParams({ sv: '99', city: 'lagos' });
    expect(decodeSavedSearchParams(params)).toBeNull();
  });

  it('accepts links without a version marker as the current version', () => {
    const restored = decodeSavedSearchParams(new URLSearchParams({ city: 'Lagos' }));
    expect(restored?.filters.city).toBe('lagos');
  });
});

describe('isAlertDue', () => {
  const now = new Date('2026-10-19T12:00:00Z');

  it('always sends for immediate searches', () => {
    expect(isAlertDue('immediate', new Date(now.getTime() - 1000), now)).toBe(true);
  });

  it('sends the first alert when nothing has been sent yet', () => {
    expect(isAlertDue('daily', null, now)).toBe(true);
    expect(isAlertDue('weekly', null, now)).toBe(true);
  });

  it('holds a daily search until 24 hours have elapsed', () => {
    expect(isAlertDue('daily', new Date(now.getTime() - 23 * HOUR), now)).toBe(false);
    expect(isAlertDue('daily', new Date(now.getTime() - DAY), now)).toBe(true);
  });

  it('holds a weekly search until seven days have elapsed', () => {
    expect(isAlertDue('weekly', new Date(now.getTime() - 6 * DAY), now)).toBe(false);
    expect(isAlertDue('weekly', new Date(now.getTime() - 7 * DAY), now)).toBe(true);
  });
});

describe('isWithinQuietHours', () => {
  const at = (time: string) => new Date(`2026-10-19T${time}:00Z`);

  it('is false when no window is configured', () => {
    expect(isWithinQuietHours(at('03:00'), null, null)).toBe(false);
    expect(isWithinQuietHours(at('03:00'), undefined, '07:00')).toBe(false);
  });

  it('handles a same-day window', () => {
    expect(isWithinQuietHours(at('13:00'), '12:00', '14:00')).toBe(true);
    expect(isWithinQuietHours(at('14:00'), '12:00', '14:00')).toBe(false);
    expect(isWithinQuietHours(at('11:59'), '12:00', '14:00')).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isWithinQuietHours(at('23:30'), '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(at('06:59'), '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(at('12:00'), '22:00', '07:00')).toBe(false);
  });

  it('accepts Postgres TIME values with seconds', () => {
    expect(isWithinQuietHours(at('03:00'), '22:00:00', '07:00:00')).toBe(true);
  });

  it('treats equal bounds and malformed times as no quiet period', () => {
    expect(isWithinQuietHours(at('03:00'), '03:00', '03:00')).toBe(false);
    expect(isWithinQuietHours(at('03:00'), 'late', '07:00')).toBe(false);
    expect(isWithinQuietHours(at('03:00'), '25:00', '07:00')).toBe(false);
  });
});
