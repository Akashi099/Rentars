/**
 * Listing form validation (#920).
 *
 * Three layers, each enforced:
 *  1. `validateStep` runs when the host tries to leave a step. A step with invalid
 *     required data cannot be left.
 *  2. `validateListing` runs on submit over the whole payload, not only the steps
 *     the host has visited (a draft may have been restored or edited).
 *  3. The API validates again (apps/backend/src/validators/property.validator.ts).
 *     `toApiPayload` builds the request from the same values, using the field names
 *     and limits that the API expects.
 *
 * Limits that mirror the API are written as constants so that a change to either
 * side is visible in one place. Form-only policy (a $10 minimum price, at least one
 * amenity, at least one photo) is marked as such.
 */

import type { ListingFormData, ListingStep } from './types';

// ── API-mirrored limits (keep in sync with property.validator.ts) ────────────

export const TITLE_MIN = 3;
export const TITLE_MAX = 100;
export const DESCRIPTION_MIN = 10;
export const DESCRIPTION_MAX = 2000;
export const ADDITIONAL_RULES_MAX = 2000;
export const CITY_MAX = 100;
export const COUNTRY_MAX = 100;
export const LAT_RANGE: [number, number] = [-90, 90];
export const LNG_RANGE: [number, number] = [-180, 180];

/** Canonical amenity ids accepted by the API (apps/backend/src/types/amenities.ts). */
export const AMENITY_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'wifi', label: 'WiFi' },
  { id: 'parking', label: 'Parking' },
  { id: 'pool', label: 'Pool' },
  { id: 'gym', label: 'Gym' },
  { id: 'air_conditioning', label: 'Air conditioning' },
  { id: 'heating', label: 'Heating' },
  { id: 'kitchen', label: 'Kitchen' },
  { id: 'washer', label: 'Washer' },
  { id: 'dryer', label: 'Dryer' },
  { id: 'tv', label: 'TV' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'elevator', label: 'Elevator' },
  { id: 'hot_tub', label: 'Hot tub' },
  { id: 'bbq_grill', label: 'BBQ grill' },
  { id: 'fireplace', label: 'Fireplace' },
  { id: 'beach_access', label: 'Beach access' },
  { id: 'ski_access', label: 'Ski access' },
  { id: 'pet_friendly', label: 'Pet friendly' },
  { id: 'smoking_allowed', label: 'Smoking allowed' },
  { id: 'wheelchair_accessible', label: 'Wheelchair accessible' },
];
const AMENITY_IDS = new Set(AMENITY_OPTIONS.map((a) => a.id));

// ── Form-only policy ─────────────────────────────────────────────────────────

export const PROPERTY_TYPES = ['apartment', 'house', 'villa', 'condo', 'studio'] as const;
/** Form policy: the minimum nightly price shown to guests. The API only requires > 0. */
export const MIN_PRICE_PER_NIGHT = 10;
/** Form policy: a listing needs at least one amenity and one photo. */
export const MIN_AMENITIES = 1;
export const MIN_PHOTOS = 1;

export type FormErrors = Record<string, string>;

/** Which step owns each field. Used to send the host back to the right step. */
export const FIELD_STEP: Record<string, ListingStep> = {
  title: 'basic',
  description: 'basic',
  propertyType: 'basic',
  maxGuests: 'basic',
  bedrooms: 'basic',
  bathrooms: 'basic',
  address: 'location',
  city: 'location',
  state: 'location',
  zipCode: 'location',
  country: 'location',
  latitude: 'location',
  longitude: 'location',
  amenities: 'amenities',
  images: 'photos',
  pricePerNight: 'pricing',
  cleaningFee: 'pricing',
  serviceFee: 'pricing',
  minNights: 'pricing',
  maxNights: 'pricing',
  checkInTime: 'pricing',
  checkOutTime: 'pricing',
  additionalRules: 'rules',
  quietHoursStart: 'rules',
  quietHoursEnd: 'rules',
  agreeToTerms: 'review',
};

const TIME_PATTERN = /^\d{2}:\d{2}$/;
const US_ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isWhole = (v: unknown): v is number => isFiniteNumber(v) && Number.isInteger(v);

const STEP_RULES: Record<ListingStep, (d: Partial<ListingFormData>, e: FormErrors) => void> = {
  basic(d, e) {
    const title = (d.title ?? '').trim();
    if (title.length < TITLE_MIN) e.title = `Title must be at least ${TITLE_MIN} characters`;
    else if (title.length > TITLE_MAX) e.title = `Title must be at most ${TITLE_MAX} characters`;

    const description = (d.description ?? '').trim();
    if (description.length < DESCRIPTION_MIN) {
      e.description = `Description must be at least ${DESCRIPTION_MIN} characters`;
    } else if (description.length > DESCRIPTION_MAX) {
      e.description = `Description must be at most ${DESCRIPTION_MAX} characters`;
    }

    if (!d.propertyType || !(PROPERTY_TYPES as readonly string[]).includes(d.propertyType)) {
      e.propertyType = 'Choose a property type';
    }
    if (!isWhole(d.maxGuests) || d.maxGuests < 1) e.maxGuests = 'At least 1 guest is required';
    if (!isWhole(d.bedrooms) || d.bedrooms < 0) e.bedrooms = 'Bedrooms must be 0 or more';
    if (!isWhole(d.bathrooms) || d.bathrooms < 0) e.bathrooms = 'Bathrooms must be 0 or more';
  },

  location(d, e) {
    if ((d.address ?? '').trim().length < 5) e.address = 'Address is required';
    const city = (d.city ?? '').trim();
    if (city.length < 1) e.city = 'City is required';
    else if (city.length > CITY_MAX) e.city = `City must be at most ${CITY_MAX} characters`;

    const country = (d.country ?? '').trim();
    if (country.length < 1) e.country = 'Country is required';
    else if (country.length > COUNTRY_MAX)
      e.country = `Country must be at most ${COUNTRY_MAX} characters`;

    if (!isFiniteNumber(d.latitude) || d.latitude < LAT_RANGE[0] || d.latitude > LAT_RANGE[1]) {
      e.latitude = `Latitude must be between ${LAT_RANGE[0]} and ${LAT_RANGE[1]}`;
    }
    if (!isFiniteNumber(d.longitude) || d.longitude < LNG_RANGE[0] || d.longitude > LNG_RANGE[1]) {
      e.longitude = `Longitude must be between ${LNG_RANGE[0]} and ${LNG_RANGE[1]}`;
    }

    // ZIP format is checked only for US addresses, because that is the only format the form knows.
    if (country.toUpperCase() === 'US' && !US_ZIP_PATTERN.test(d.zipCode ?? '')) {
      e.zipCode = 'Invalid zip code';
    }
  },

  amenities(d, e) {
    const selected = d.amenities ?? [];
    if (selected.length < MIN_AMENITIES) e.amenities = 'Select at least one amenity';
    else if (selected.some((a) => !AMENITY_IDS.has(a)))
      e.amenities = 'Remove unsupported amenities';
  },

  photos(d, e) {
    if ((d.images ?? []).length < MIN_PHOTOS) e.images = 'Upload at least one photo';
  },

  pricing(d, e) {
    if (!isFiniteNumber(d.pricePerNight) || d.pricePerNight < MIN_PRICE_PER_NIGHT) {
      e.pricePerNight = `Price must be at least $${MIN_PRICE_PER_NIGHT}`;
    }
    if (!isFiniteNumber(d.cleaningFee) || d.cleaningFee < 0)
      e.cleaningFee = 'Cleaning fee cannot be negative';
    if (!isFiniteNumber(d.serviceFee) || d.serviceFee < 0)
      e.serviceFee = 'Service fee cannot be negative';

    const minNights = d.minNights ?? 1;
    if (!isWhole(minNights) || minNights < 1) e.minNights = 'Minimum stay must be at least 1 night';
    if (d.maxNights !== null && d.maxNights !== undefined) {
      if (!isWhole(d.maxNights) || d.maxNights < minNights) {
        e.maxNights = 'Maximum stay must be at least the minimum stay';
      }
    }

    if (!TIME_PATTERN.test(d.checkInTime ?? '')) e.checkInTime = 'Check-in time must be HH:MM';
    if (!TIME_PATTERN.test(d.checkOutTime ?? '')) e.checkOutTime = 'Check-out time must be HH:MM';
  },

  rules(d, e) {
    if ((d.additionalRules ?? '').length > ADDITIONAL_RULES_MAX) {
      e.additionalRules = `Additional rules must be under ${ADDITIONAL_RULES_MAX} characters`;
    }
    const start = d.quietHoursStart ?? '';
    const end = d.quietHoursEnd ?? '';
    // Quiet hours are a pair: a start without an end, or the reverse, is not a rule.
    if (start !== '' && !TIME_PATTERN.test(start)) e.quietHoursStart = 'Use HH:MM';
    if (end !== '' && !TIME_PATTERN.test(end)) e.quietHoursEnd = 'Use HH:MM';
    if ((start === '') !== (end === '')) {
      e[start === '' ? 'quietHoursStart' : 'quietHoursEnd'] =
        'Set both quiet-hours times, or neither';
    }
  },

  review(d, e) {
    if (d.agreeToTerms !== true) e.agreeToTerms = 'You must agree to terms';
  },
};

/** Validates only the fields the given step owns. Returns {} when the step may be left. */
export function validateStep(step: ListingStep, data: Partial<ListingFormData>): FormErrors {
  const errors: FormErrors = {};
  STEP_RULES[step](data, errors);
  return errors;
}

/**
 * Validates every step. Returns the errors, and the first step that has one, so the
 * form can take the host there.
 */
export function validateListing(
  data: Partial<ListingFormData>,
  steps: readonly ListingStep[] = Object.keys(STEP_RULES) as ListingStep[]
): { errors: FormErrors; firstInvalidStep: ListingStep | null } {
  const errors: FormErrors = {};
  let firstInvalidStep: ListingStep | null = null;
  for (const step of steps) {
    const stepErrors = validateStep(step, data);
    if (Object.keys(stepErrors).length > 0 && firstInvalidStep === null) firstInvalidStep = step;
    Object.assign(errors, stepErrors);
  }
  return { errors, firstInvalidStep };
}

/**
 * Builds the JSON body the create endpoint expects. Field names and nesting follow
 * the API validator. Photos are not part of this body: they are uploaded afterwards,
 * one at a time, so each one's result can be reported.
 */
export function toApiPayload(data: Partial<ListingFormData>): Record<string, unknown> {
  return {
    title: (data.title ?? '').trim(),
    description: (data.description ?? '').trim(),
    price_per_night: data.pricePerNight,
    location: {
      city: (data.city ?? '').trim(),
      country: (data.country ?? '').trim(),
      lat: data.latitude,
      lng: data.longitude,
    },
    amenities: data.amenities ?? [],
    max_guests: data.maxGuests,
    bedrooms: data.bedrooms,
    bathrooms: data.bathrooms,
    min_nights: data.minNights ?? 1,
    max_nights: data.maxNights ?? null,
    check_in_time: data.checkInTime,
    check_out_time: data.checkOutTime,
    property_type: data.propertyType,
  };
}

/** Maps an API validation field (snake_case path) back to the form field the host sees. */
const API_FIELD_TO_FORM: Record<string, string> = {
  title: 'title',
  description: 'description',
  price_per_night: 'pricePerNight',
  'location.city': 'city',
  'location.country': 'country',
  'location.lat': 'latitude',
  'location.lng': 'longitude',
  max_guests: 'maxGuests',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  min_nights: 'minNights',
  max_nights: 'maxNights',
  check_in_time: 'checkInTime',
  check_out_time: 'checkOutTime',
};

/** Converts a server `fields` map into form errors, keyed by the form's field names. */
export function apiErrorsToFormErrors(fields: Record<string, string[]>): {
  errors: FormErrors;
  firstInvalidStep: ListingStep | null;
} {
  const errors: FormErrors = {};
  let firstInvalidStep: ListingStep | null = null;
  for (const [apiField, messages] of Object.entries(fields)) {
    const formField =
      API_FIELD_TO_FORM[apiField] ?? (apiField.startsWith('amenities') ? 'amenities' : apiField);
    errors[formField] = messages[0] ?? 'Invalid value';
    const step = FIELD_STEP[formField];
    if (step && firstInvalidStep === null) firstInvalidStep = step;
  }
  return { errors, firstInvalidStep };
}
