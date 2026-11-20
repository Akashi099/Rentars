/**
 * Listing validation (#920): step gating, cross-field rules, boundary values, the
 * payload contract with the API, and mapping of server errors back to form fields.
 */
import { describe, expect, it } from 'vitest';
import type { ListingFormData } from '../types';
import {
  AMENITY_OPTIONS,
  apiErrorsToFormErrors,
  toApiPayload,
  validateListing,
  validateStep,
} from '../validation';

const validListing: Partial<ListingFormData> = {
  title: 'Sunny loft',
  description: 'A bright loft with a view of the river.',
  propertyType: 'apartment',
  maxGuests: 2,
  bedrooms: 1,
  bathrooms: 1,
  address: '12 River Road',
  city: 'Lagos',
  state: 'LA',
  zipCode: '100001',
  country: 'NG',
  latitude: 6.5,
  longitude: 3.4,
  amenities: ['wifi'],
  images: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })],
  pricePerNight: 120,
  cleaningFee: 10,
  serviceFee: 5,
  minNights: 1,
  maxNights: null,
  checkInTime: '15:00',
  checkOutTime: '11:00',
  additionalRules: '',
  quietHoursStart: '',
  quietHoursEnd: '',
  agreeToTerms: true,
};

describe('validateStep — basic', () => {
  it('accepts a valid title and description', () => {
    expect(validateStep('basic', validListing)).toEqual({});
  });

  it('matches the API minimum title length: 3 is accepted, 2 is not', () => {
    expect(validateStep('basic', { ...validListing, title: 'abc' })).toEqual({});
    expect(validateStep('basic', { ...validListing, title: 'ab' })).toHaveProperty('title');
  });

  it('matches the API title maximum: 100 accepted, 101 refused', () => {
    expect(validateStep('basic', { ...validListing, title: 'a'.repeat(100) })).toEqual({});
    expect(validateStep('basic', { ...validListing, title: 'a'.repeat(101) })).toHaveProperty(
      'title'
    );
  });

  it('refuses a whitespace-only title', () => {
    expect(validateStep('basic', { ...validListing, title: '     ' })).toHaveProperty('title');
  });

  it('matches the API description minimum (10) and maximum (2000)', () => {
    expect(validateStep('basic', { ...validListing, description: '123456789' })).toHaveProperty(
      'description'
    );
    expect(validateStep('basic', { ...validListing, description: '1234567890' })).toEqual({});
    expect(
      validateStep('basic', { ...validListing, description: 'a'.repeat(2001) })
    ).toHaveProperty('description');
  });

  it('refuses a missing or unknown property type', () => {
    expect(validateStep('basic', { ...validListing, propertyType: undefined })).toHaveProperty(
      'propertyType'
    );
    expect(validateStep('basic', { ...validListing, propertyType: 'castle' })).toHaveProperty(
      'propertyType'
    );
  });

  it('refuses fractional or zero guest counts', () => {
    expect(validateStep('basic', { ...validListing, maxGuests: 0 })).toHaveProperty('maxGuests');
    expect(validateStep('basic', { ...validListing, maxGuests: 1.5 })).toHaveProperty('maxGuests');
  });
});

describe('validateStep — location', () => {
  it('requires coordinates, because the API does', () => {
    const errors = validateStep('location', {
      ...validListing,
      latitude: undefined,
      longitude: undefined,
    });
    expect(errors).toHaveProperty('latitude');
    expect(errors).toHaveProperty('longitude');
  });

  it('accepts coordinates on the range boundaries and refuses just outside', () => {
    expect(validateStep('location', { ...validListing, latitude: 90, longitude: -180 })).toEqual(
      {}
    );
    const out = validateStep('location', {
      ...validListing,
      latitude: 90.0001,
      longitude: 180.0001,
    });
    expect(out).toHaveProperty('latitude');
    expect(out).toHaveProperty('longitude');
  });

  it('requires a country', () => {
    expect(validateStep('location', { ...validListing, country: '' })).toHaveProperty('country');
  });

  it('checks the zip format only for US addresses', () => {
    expect(
      validateStep('location', { ...validListing, country: 'US', zipCode: '9021' })
    ).toHaveProperty('zipCode');
    expect(
      validateStep('location', { ...validListing, country: 'US', zipCode: '90210-1234' })
    ).toEqual({});
    expect(validateStep('location', { ...validListing, country: 'NG', zipCode: '100001' })).toEqual(
      {}
    );
  });

  it('will not let the host move on without an address', () => {
    expect(validateStep('location', { ...validListing, address: 'abc' })).toHaveProperty('address');
  });
});

describe('validateStep — amenities and photos', () => {
  it('accepts only canonical amenity ids', () => {
    expect(validateStep('amenities', { ...validListing, amenities: ['air_conditioning'] })).toEqual(
      {}
    );
    expect(
      validateStep('amenities', { ...validListing, amenities: ['Air Conditioning'] })
    ).toHaveProperty('amenities');
    expect(
      validateStep('amenities', { ...validListing, amenities: ['dishwasher'] })
    ).toHaveProperty('amenities');
  });

  it('requires at least one amenity (form policy)', () => {
    expect(validateStep('amenities', { ...validListing, amenities: [] })).toHaveProperty(
      'amenities'
    );
  });

  it('requires at least one photo before leaving the photos step', () => {
    expect(validateStep('photos', { ...validListing, images: [] })).toHaveProperty('images');
    expect(validateStep('photos', validListing)).toEqual({});
  });

  it('keeps the amenity options to ids the API knows', () => {
    expect(AMENITY_OPTIONS.map((a) => a.id)).toContain('wifi');
    expect(AMENITY_OPTIONS.map((a) => a.id)).not.toContain('dishwasher');
  });
});

describe('validateStep — pricing (cross-field)', () => {
  it('refuses a price below the form minimum', () => {
    expect(validateStep('pricing', { ...validListing, pricePerNight: 9 })).toHaveProperty(
      'pricePerNight'
    );
    expect(validateStep('pricing', { ...validListing, pricePerNight: 10 })).toEqual({});
  });

  it('refuses a maximum stay shorter than the minimum stay', () => {
    const errors = validateStep('pricing', { ...validListing, minNights: 5, maxNights: 3 });
    expect(errors).toHaveProperty('maxNights');
  });

  it('accepts a maximum stay equal to the minimum', () => {
    expect(validateStep('pricing', { ...validListing, minNights: 3, maxNights: 3 })).toEqual({});
  });

  it('refuses negative fees', () => {
    expect(validateStep('pricing', { ...validListing, cleaningFee: -1 })).toHaveProperty(
      'cleaningFee'
    );
    expect(validateStep('pricing', { ...validListing, serviceFee: -1 })).toHaveProperty(
      'serviceFee'
    );
  });

  it('refuses check-in times that are not HH:MM', () => {
    expect(validateStep('pricing', { ...validListing, checkInTime: '3pm' })).toHaveProperty(
      'checkInTime'
    );
  });
});

describe('validateStep — house rules', () => {
  it('requires quiet hours to be set as a pair', () => {
    expect(
      validateStep('rules', { ...validListing, quietHoursStart: '22:00', quietHoursEnd: '' })
    ).toHaveProperty('quietHoursEnd');
    expect(
      validateStep('rules', { ...validListing, quietHoursStart: '', quietHoursEnd: '07:00' })
    ).toHaveProperty('quietHoursStart');
    expect(
      validateStep('rules', { ...validListing, quietHoursStart: '22:00', quietHoursEnd: '07:00' })
    ).toEqual({});
  });

  it('caps additional rules at 2000 characters', () => {
    expect(
      validateStep('rules', { ...validListing, additionalRules: 'a'.repeat(2001) })
    ).toHaveProperty('additionalRules');
  });
});

describe('validateListing — whole payload on submit', () => {
  it('returns the first invalid step so the host is taken there', () => {
    const { errors, firstInvalidStep } = validateListing({
      ...validListing,
      title: 'x',
      pricePerNight: 1,
    });
    expect(firstInvalidStep).toBe('basic');
    expect(errors).toHaveProperty('title');
    expect(errors).toHaveProperty('pricePerNight');
  });

  it('is clean for a complete listing', () => {
    expect(validateListing(validListing)).toEqual({ errors: {}, firstInvalidStep: null });
  });

  it('catches a stale draft missing photos even if earlier steps passed', () => {
    const { firstInvalidStep } = validateListing({ ...validListing, images: [] });
    expect(firstInvalidStep).toBe('photos');
  });
});

describe('toApiPayload — the contract with the API', () => {
  it('uses the API field names and nests the location', () => {
    const body = toApiPayload(validListing);
    expect(body).toMatchObject({
      title: 'Sunny loft',
      price_per_night: 120,
      location: { city: 'Lagos', country: 'NG', lat: 6.5, lng: 3.4 },
      max_guests: 2,
      min_nights: 1,
      max_nights: null,
      check_in_time: '15:00',
      check_out_time: '11:00',
      amenities: ['wifi'],
    });
  });

  it('trims free text', () => {
    const body = toApiPayload({ ...validListing, title: '  Loft  ', description: ' text ' });
    expect(body.title).toBe('Loft');
    expect(body.description).toBe('text');
  });

  it('does not send photos in the create body', () => {
    expect(toApiPayload(validListing)).not.toHaveProperty('images');
  });
});

describe('apiErrorsToFormErrors — server rejection brings the host back to the field', () => {
  it('maps API paths to form fields and reports the step', () => {
    const { errors, firstInvalidStep } = apiErrorsToFormErrors({
      price_per_night: ['price_per_night must be a positive number'],
      'location.lat': ['lat must be between -90 and 90'],
    });
    expect(errors).toEqual({
      pricePerNight: 'price_per_night must be a positive number',
      latitude: 'lat must be between -90 and 90',
    });
    expect(firstInvalidStep).toBe('pricing');
  });

  it('maps amenity list errors to the amenities field', () => {
    const { errors, firstInvalidStep } = apiErrorsToFormErrors({
      'amenities.0': ['amenities must be one of'],
    });
    expect(errors).toHaveProperty('amenities');
    expect(firstInvalidStep).toBe('amenities');
  });
});
