'use client';

import { buildDescribedBy } from '@/components/ui/form-field';
import { formStyles } from '../styles';
import type { ListingFormData } from '../types';

interface LocationStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function LocationStep({ formData, setFormData, errors }: LocationStepProps) {
  return (
    <div className="space-y-6">
      {/* Address */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-address" className={formStyles.label}>
          Address
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
            *
          </span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="listing-address"
          type="text"
          value={formData.address || ''}
          onChange={(e) => setFormData({ ...formData, address: e.target.value })}
          placeholder="Street address"
          autoComplete="street-address"
          required
          aria-required
          aria-invalid={!!errors.address || undefined}
          aria-describedby={buildDescribedBy('listing-address', !!errors.address, false)}
          className={errors.address ? formStyles.inputError : formStyles.input}
        />
        {errors.address && (
          <p
            id="listing-address-error"
            role="alert"
            aria-live="polite"
            className={formStyles.error}
          >
            {errors.address}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* City */}
        <div className={formStyles.formGroup}>
          <label htmlFor="listing-city" className={formStyles.label}>
            City
            <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
              *
            </span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="listing-city"
            type="text"
            value={formData.city || ''}
            onChange={(e) => setFormData({ ...formData, city: e.target.value })}
            placeholder="City"
            autoComplete="address-level2"
            required
            aria-required
            aria-invalid={!!errors.city || undefined}
            aria-describedby={buildDescribedBy('listing-city', !!errors.city, false)}
            className={errors.city ? formStyles.inputError : formStyles.input}
          />
          {errors.city && (
            <p id="listing-city-error" role="alert" aria-live="polite" className={formStyles.error}>
              {errors.city}
            </p>
          )}
        </div>

        {/* State */}
        <div className={formStyles.formGroup}>
          <label htmlFor="listing-state" className={formStyles.label}>
            State
            <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
              *
            </span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="listing-state"
            type="text"
            value={formData.state || ''}
            onChange={(e) => setFormData({ ...formData, state: e.target.value })}
            placeholder="State"
            autoComplete="address-level1"
            required
            aria-required
            aria-invalid={!!errors.state || undefined}
            aria-describedby={buildDescribedBy('listing-state', !!errors.state, false)}
            className={errors.state ? formStyles.inputError : formStyles.input}
          />
          {errors.state && (
            <p
              id="listing-state-error"
              role="alert"
              aria-live="polite"
              className={formStyles.error}
            >
              {errors.state}
            </p>
          )}
        </div>
      </div>

      {/* Zip Code */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-zip" className={formStyles.label}>
          Zip Code
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
            *
          </span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="listing-zip"
          type="text"
          inputMode="numeric"
          value={formData.zipCode || ''}
          onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
          placeholder="12345"
          autoComplete="postal-code"
          required
          aria-required
          aria-invalid={!!errors.zipCode || undefined}
          aria-describedby={buildDescribedBy('listing-zip', !!errors.zipCode, true)}
          className={errors.zipCode ? formStyles.inputError : formStyles.input}
        />
        <p id="listing-zip-hint" className="text-xs text-gray-500 mt-1">
          5-digit US zip code (e.g. 90210 or 90210-1234)
        </p>
        {errors.zipCode && (
          <p id="listing-zip-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.zipCode}
          </p>
        )}
      </div>

      {/* Country */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-country" className={formStyles.label}>
          Country
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
            *
          </span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="listing-country"
          type="text"
          value={formData.country || ''}
          onChange={(e) => setFormData({ ...formData, country: e.target.value })}
          placeholder="Country code or name, e.g. US"
          autoComplete="country"
          required
          aria-required
          aria-invalid={!!errors.country || undefined}
          aria-describedby={buildDescribedBy('listing-country', !!errors.country, false)}
          className={errors.country ? formStyles.inputError : formStyles.input}
        />
        {errors.country && (
          <p
            id="listing-country-error"
            role="alert"
            aria-live="polite"
            className={formStyles.error}
          >
            {errors.country}
          </p>
        )}
      </div>

      {/* Coordinates: the API requires them, so the form asks for them directly. */}
      <div className="grid grid-cols-2 gap-4">
        <div className={formStyles.formGroup}>
          <label htmlFor="listing-latitude" className={formStyles.label}>
            Latitude
            <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
              *
            </span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="listing-latitude"
            type="number"
            step="any"
            min={-90}
            max={90}
            value={formData.latitude ?? ''}
            onChange={(e) =>
              setFormData({
                ...formData,
                latitude: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            placeholder="-90 to 90"
            required
            aria-required
            aria-invalid={!!errors.latitude || undefined}
            aria-describedby={buildDescribedBy('listing-latitude', !!errors.latitude, true)}
            className={errors.latitude ? formStyles.inputError : formStyles.input}
          />
          <p id="listing-latitude-hint" className="text-xs text-gray-500 mt-1">
            Guests see an approximate location, not this exact point.
          </p>
          {errors.latitude && (
            <p
              id="listing-latitude-error"
              role="alert"
              aria-live="polite"
              className={formStyles.error}
            >
              {errors.latitude}
            </p>
          )}
        </div>

        <div className={formStyles.formGroup}>
          <label htmlFor="listing-longitude" className={formStyles.label}>
            Longitude
            <span aria-hidden="true" className="ml-1 text-red-500 font-normal">
              *
            </span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="listing-longitude"
            type="number"
            step="any"
            min={-180}
            max={180}
            value={formData.longitude ?? ''}
            onChange={(e) =>
              setFormData({
                ...formData,
                longitude: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            placeholder="-180 to 180"
            required
            aria-required
            aria-invalid={!!errors.longitude || undefined}
            aria-describedby={buildDescribedBy('listing-longitude', !!errors.longitude, true)}
            className={errors.longitude ? formStyles.inputError : formStyles.input}
          />
          <p id="listing-longitude-hint" className="text-xs text-gray-500 mt-1">
            Copy both values from your map app.
          </p>
          {errors.longitude && (
            <p
              id="listing-longitude-error"
              role="alert"
              aria-live="polite"
              className={formStyles.error}
            >
              {errors.longitude}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
