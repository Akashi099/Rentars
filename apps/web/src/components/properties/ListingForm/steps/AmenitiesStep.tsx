'use client';

import { formStyles } from '../styles';
import type { ListingFormData } from '../types';
import { AMENITY_OPTIONS } from '../validation';

interface AmenitiesStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

export default function AmenitiesStep({ formData, setFormData, errors }: AmenitiesStepProps) {
  // Values are the canonical ids the API accepts, so the form cannot submit an amenity the API refuses.
  const toggleAmenity = (amenityId: string) => {
    const current = formData.amenities || [];
    const updated = current.includes(amenityId)
      ? current.filter((a) => a !== amenityId)
      : [...current, amenityId];
    setFormData({ ...formData, amenities: updated });
  };

  return (
    <div className="space-y-6">
      <p className="text-gray-600">Select all amenities your property offers</p>

      <div className="grid grid-cols-2 gap-4">
        {AMENITY_OPTIONS.map((amenity) => (
          <label key={amenity.id} className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={(formData.amenities || []).includes(amenity.id)}
              onChange={() => toggleAmenity(amenity.id)}
              className={formStyles.checkbox}
            />
            <span>{amenity.label}</span>
          </label>
        ))}
      </div>

      {errors.amenities && <p className={formStyles.error}>{errors.amenities}</p>}
    </div>
  );
}
