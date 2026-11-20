/**
 * Server-side listing validation at the create/update boundary (#920).
 * The same rules guard the web form's step transitions, so a direct API call
 * cannot store values the form would refuse.
 */
import { describe, expect, it } from 'bun:test';
import { propertySchema, updatePropertySchema } from '../../src/validators/property.validator';

const valid = {
  title: 'Sunny loft',
  description: 'A bright loft with a view of the river and fast wifi.',
  price_per_night: 120,
  location: { city: 'Lagos', country: 'NG', lat: 6.5, lng: 3.4 },
  amenities: [],
  max_guests: 2,
  bedrooms: 1,
  bathrooms: 1,
  images: [],
};

const fieldsOf = (body: unknown) => {
  const r = propertySchema.safeParse(body);
  return r.success ? null : r.error.issues.map((i) => i.path.join('.'));
};

describe('propertySchema — boundary values', () => {
  it('accepts the minimum valid listing', () => {
    expect(propertySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a title one character short of the minimum and one over the maximum', () => {
    expect(fieldsOf({ ...valid, title: 'ab' })).toContain('title');
    expect(fieldsOf({ ...valid, title: 'a'.repeat(101) })).toContain('title');
    expect(fieldsOf({ ...valid, title: 'abc' })).toBeNull();
    expect(fieldsOf({ ...valid, title: 'a'.repeat(100) })).toBeNull();
  });

  it('rejects a zero or negative nightly price', () => {
    expect(fieldsOf({ ...valid, price_per_night: 0 })).toContain('price_per_night');
    expect(fieldsOf({ ...valid, price_per_night: -5 })).toContain('price_per_night');
  });

  it('rejects latitude and longitude outside their ranges', () => {
    expect(fieldsOf({ ...valid, location: { ...valid.location, lat: 90.1 } })).toContain(
      'location.lat'
    );
    expect(fieldsOf({ ...valid, location: { ...valid.location, lng: -180.5 } })).toContain(
      'location.lng'
    );
  });

  it('rejects an amenity outside the canonical list', () => {
    expect(fieldsOf({ ...valid, amenities: ['not-a-real-amenity'] })).toContain('amenities.0');
  });

  it('rejects max_nights below min_nights (cross-field)', () => {
    const body = { ...valid, min_nights: 5, max_nights: 3 };
    const result = propertySchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((i) => i.path.join('.'))).toContain(
      'max_nights'
    );
  });

  it('accepts max_nights equal to min_nights', () => {
    expect(propertySchema.safeParse({ ...valid, min_nights: 3, max_nights: 3 }).success).toBe(true);
  });

  it('rejects check-in times not in HH:MM form', () => {
    expect(fieldsOf({ ...valid, check_in_time: '3pm' })).toContain('check_in_time');
  });
});

describe('updatePropertySchema — partial updates keep the same rules', () => {
  it('accepts a partial update that is valid on its own', () => {
    expect(updatePropertySchema.safeParse({ price_per_night: 99 }).success).toBe(true);
  });

  it('still rejects an invalid field in a partial update', () => {
    expect(updatePropertySchema.safeParse({ price_per_night: 0 }).success).toBe(false);
  });

  it('still rejects max_nights below min_nights when both are sent', () => {
    expect(updatePropertySchema.safeParse({ min_nights: 4, max_nights: 2 }).success).toBe(false);
  });
});
