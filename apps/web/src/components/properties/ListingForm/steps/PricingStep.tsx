'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';
import { buildDescribedBy } from '@/components/ui/form-field';

interface PricingStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function PricingStep({ formData, setFormData, errors }: PricingStepProps) {
  return (
    <div className="space-y-6">
      {/* ── Capacity ───────────────────────────────────────────────────── */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-semibold text-gray-700 px-1">Capacity</legend>

        <div className="grid grid-cols-3 gap-4 mt-2">
          <div className={formStyles.formGroup}>
            <label htmlFor="maxGuests" className={formStyles.label}>
              Max Guests
              <span aria-hidden="true" className="ml-1 text-red-500 font-normal">*</span>
              <span className="sr-only">(required)</span>
            </label>
            <input
              id="maxGuests"
              type="number"
              min="1"
              value={formData.maxGuests ?? ''}
              onChange={(e) =>
                setFormData({ ...formData, maxGuests: parseInt(e.target.value, 10) || 1 })
              }
              placeholder="1"
              required
              aria-required
              aria-invalid={!!errors.maxGuests || undefined}
              aria-describedby={buildDescribedBy('maxGuests', !!errors.maxGuests, false)}
              className={errors.maxGuests ? formStyles.inputError : formStyles.input}
            />
            {errors.maxGuests && (
              <p id="maxGuests-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.maxGuests}
              </p>
            )}
          </div>

          <div className={formStyles.formGroup}>
            <label htmlFor="bedrooms" className={formStyles.label}>
              Bedrooms
            </label>
            <input
              id="bedrooms"
              type="number"
              min="0"
              value={formData.bedrooms ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setFormData({ ...formData, bedrooms: undefined as unknown as number });
                  return;
                }
                const parsed = parseInt(raw, 10);
                if (!Number.isNaN(parsed)) {
                  setFormData({ ...formData, bedrooms: parsed });
                }
              }}
              placeholder="0"
              aria-invalid={!!errors.bedrooms || undefined}
              aria-describedby={buildDescribedBy('bedrooms', !!errors.bedrooms, false)}
              className={errors.bedrooms ? formStyles.inputError : formStyles.input}
            />
            {errors.bedrooms && (
              <p id="bedrooms-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.bedrooms}
              </p>
            )}
          </div>

          <div className={formStyles.formGroup}>
            <label htmlFor="bathrooms" className={formStyles.label}>
              Bathrooms
            </label>
            <input
              id="bathrooms"
              type="number"
              min="0"
              value={formData.bathrooms ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setFormData({ ...formData, bathrooms: undefined as unknown as number });
                  return;
                }
                const parsed = parseInt(raw, 10);
                if (!Number.isNaN(parsed)) {
                  setFormData({ ...formData, bathrooms: parsed });
                }
              }}
              placeholder="0"
              aria-invalid={!!errors.bathrooms || undefined}
              aria-describedby={buildDescribedBy('bathrooms', !!errors.bathrooms, false)}
              className={errors.bathrooms ? formStyles.inputError : formStyles.input}
            />
            {errors.bathrooms && (
              <p id="bathrooms-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.bathrooms}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      {/* ── Pricing ────────────────────────────────────────────────────── */}
      <div className={formStyles.formGroup}>
        <label htmlFor="pricePerNight" className={formStyles.label}>
          Price per Night (USDC)
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">*</span>
          <span className="sr-only">(required)</span>
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-xl font-semibold">$</span>
          <input
            id="pricePerNight"
            type="number"
            value={formData.pricePerNight || ''}
            onChange={(e) => setFormData({ ...formData, pricePerNight: Number(e.target.value) })}
            placeholder="0"
            min="10"
            required
            aria-required
            aria-invalid={!!errors.pricePerNight || undefined}
            aria-describedby={buildDescribedBy('pricePerNight', !!errors.pricePerNight, false)}
            className={errors.pricePerNight ? formStyles.inputError : formStyles.input}
          />
        </div>
        {errors.pricePerNight && (
          <p id="pricePerNight-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.pricePerNight}
          </p>
        )}
      </div>

      <div className={formStyles.formGroup}>
        <label htmlFor="cleaningFee" className={formStyles.label}>
          Cleaning Fee (USDC)
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-xl font-semibold">$</span>
          <input
            id="cleaningFee"
            type="number"
            value={formData.cleaningFee || ''}
            onChange={(e) => setFormData({ ...formData, cleaningFee: Number(e.target.value) })}
            placeholder="0"
            min="0"
            aria-invalid={!!errors.cleaningFee || undefined}
            aria-describedby={buildDescribedBy('cleaningFee', !!errors.cleaningFee, false)}
            className={errors.cleaningFee ? formStyles.inputError : formStyles.input}
          />
        </div>
        {errors.cleaningFee && (
          <p id="cleaningFee-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.cleaningFee}
          </p>
        )}
      </div>

      <div className={formStyles.formGroup}>
        <label htmlFor="serviceFee" className={formStyles.label}>
          Service Fee (USDC)
        </label>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-xl font-semibold">$</span>
          <input
            id="serviceFee"
            type="number"
            value={formData.serviceFee || ''}
            onChange={(e) => setFormData({ ...formData, serviceFee: Number(e.target.value) })}
            placeholder="0"
            min="0"
            aria-invalid={!!errors.serviceFee || undefined}
            aria-describedby={buildDescribedBy('serviceFee', !!errors.serviceFee, false)}
            className={errors.serviceFee ? formStyles.inputError : formStyles.input}
          />
        </div>
        {errors.serviceFee && (
          <p id="serviceFee-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.serviceFee}
          </p>
        )}
      </div>

      {/* ── Stay Length ────────────────────────────────────────────────── */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-semibold text-gray-700 px-1">Stay Length</legend>
        <div className="grid grid-cols-2 gap-4 mt-2">
          <div className={formStyles.formGroup}>
            <label htmlFor="minNights" className={formStyles.label}>
              Minimum Nights
            </label>
            <input
              id="minNights"
              type="number"
              min="1"
              value={formData.minNights ?? 1}
              onChange={(e) =>
                setFormData({ ...formData, minNights: Math.max(1, parseInt(e.target.value, 10) || 1) })
              }
              aria-invalid={!!errors.minNights || undefined}
              aria-describedby={buildDescribedBy('minNights', !!errors.minNights, false)}
              className={errors.minNights ? formStyles.inputError : formStyles.input}
            />
            {errors.minNights && (
              <p id="minNights-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.minNights}
              </p>
            )}
          </div>
          <div className={formStyles.formGroup}>
            <label htmlFor="maxNights" className={formStyles.label}>
              Maximum Nights
            </label>
            <input
              id="maxNights"
              type="number"
              min="1"
              value={formData.maxNights ?? ''}
              onChange={(e) => {
                const val = e.target.value === '' ? null : Math.max(1, parseInt(e.target.value, 10) || 1);
                setFormData({ ...formData, maxNights: val });
              }}
              placeholder="No limit"
              aria-invalid={!!errors.maxNights || undefined}
              aria-describedby={buildDescribedBy('maxNights', !!errors.maxNights, true)}
              className={errors.maxNights ? formStyles.inputError : formStyles.input}
            />
            <p id="maxNights-hint" className="text-xs text-gray-500 mt-1">
              Leave blank for no maximum
            </p>
            {errors.maxNights && (
              <p id="maxNights-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.maxNights}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      {/* ── Check-in / Check-out Times ──────────────────────────────────── */}
      <fieldset className="border border-gray-200 rounded-lg p-4">
        <legend className="text-sm font-semibold text-gray-700 px-1">Check-in / Check-out Times</legend>
        <div className="grid grid-cols-2 gap-4 mt-2">
          <div className={formStyles.formGroup}>
            <label htmlFor="checkInTime" className={formStyles.label}>
              Check-in Time
            </label>
            <input
              id="checkInTime"
              type="time"
              value={formData.checkInTime ?? '15:00'}
              onChange={(e) => setFormData({ ...formData, checkInTime: e.target.value })}
              aria-invalid={!!errors.checkInTime || undefined}
              aria-describedby={buildDescribedBy('checkInTime', !!errors.checkInTime, false)}
              className={errors.checkInTime ? formStyles.inputError : formStyles.input}
            />
            {errors.checkInTime && (
              <p id="checkInTime-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.checkInTime}
              </p>
            )}
          </div>
          <div className={formStyles.formGroup}>
            <label htmlFor="checkOutTime" className={formStyles.label}>
              Check-out Time
            </label>
            <input
              id="checkOutTime"
              type="time"
              value={formData.checkOutTime ?? '11:00'}
              onChange={(e) => setFormData({ ...formData, checkOutTime: e.target.value })}
              aria-invalid={!!errors.checkOutTime || undefined}
              aria-describedby={buildDescribedBy('checkOutTime', !!errors.checkOutTime, false)}
              className={errors.checkOutTime ? formStyles.inputError : formStyles.input}
            />
            {errors.checkOutTime && (
              <p id="checkOutTime-error" role="alert" aria-live="polite" className={formStyles.error}>
                {errors.checkOutTime}
              </p>
            )}
          </div>
        </div>
      </fieldset>

      {/* ── Summary ────────────────────────────────────────────────────── */}
      <div className="p-4 bg-gray-50 rounded-lg" aria-label="Pricing summary">
        <p className="text-sm font-semibold mb-2">Summary</p>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt>Max Guests:</dt>
            <dd>{formData.maxGuests ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Per Night:</dt>
            <dd>${formData.pricePerNight || 0}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Cleaning Fee:</dt>
            <dd>${formData.cleaningFee || 0}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Service Fee:</dt>
            <dd>${formData.serviceFee || 0}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Min Stay:</dt>
            <dd>{formData.minNights ?? 1} night{(formData.minNights ?? 1) !== 1 ? 's' : ''}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Max Stay:</dt>
            <dd>{formData.maxNights ? `${formData.maxNights} nights` : 'No limit'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Check-in:</dt>
            <dd>{formData.checkInTime ?? '15:00'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Check-out:</dt>
            <dd>{formData.checkOutTime ?? '11:00'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
