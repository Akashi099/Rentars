'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';
import { buildDescribedBy } from '@/components/ui/form-field';

interface BasicInfoStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function BasicInfoStep({ formData, setFormData, errors }: BasicInfoStepProps) {
  return (
    <div className="space-y-6">
      {/* Title */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-title" className={formStyles.label}>
          Property Title
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">*</span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="listing-title"
          type="text"
          value={formData.title || ''}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          placeholder="e.g., Cozy Downtown Apartment"
          required
          aria-required
          aria-invalid={!!errors.title || undefined}
          aria-describedby={buildDescribedBy('listing-title', !!errors.title, false)}
          className={errors.title ? formStyles.inputError : formStyles.input}
        />
        {errors.title && (
          <p id="listing-title-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.title}
          </p>
        )}
      </div>

      {/* Description */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-description" className={formStyles.label}>
          Description
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">*</span>
          <span className="sr-only">(required)</span>
        </label>
        <textarea
          id="listing-description"
          value={formData.description || ''}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          placeholder="Describe your property..."
          rows={5}
          required
          aria-required
          aria-invalid={!!errors.description || undefined}
          aria-describedby={buildDescribedBy('listing-description', !!errors.description, false)}
          className={errors.description ? formStyles.textareaError : formStyles.textarea}
        />
        {errors.description && (
          <p id="listing-description-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.description}
          </p>
        )}
      </div>

      {/* Property Type */}
      <div className={formStyles.formGroup}>
        <label htmlFor="listing-property-type" className={formStyles.label}>
          Property Type
          <span aria-hidden="true" className="ml-1 text-red-500 font-normal">*</span>
          <span className="sr-only">(required)</span>
        </label>
        <select
          id="listing-property-type"
          value={formData.propertyType || ''}
          onChange={(e) => setFormData({ ...formData, propertyType: e.target.value })}
          required
          aria-required
          aria-invalid={!!errors.propertyType || undefined}
          aria-describedby={buildDescribedBy('listing-property-type', !!errors.propertyType, false)}
          className={errors.propertyType ? formStyles.selectError : formStyles.select}
        >
          <option value="" disabled>Select a type</option>
          <option value="apartment">Apartment</option>
          <option value="house">House</option>
          <option value="villa">Villa</option>
          <option value="condo">Condo</option>
          <option value="studio">Studio</option>
        </select>
        {errors.propertyType && (
          <p id="listing-property-type-error" role="alert" aria-live="polite" className={formStyles.error}>
            {errors.propertyType}
          </p>
        )}
      </div>
    </div>
  );
}
