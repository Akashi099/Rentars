'use client';

import type { ListingFormData } from '../types';
import { formStyles } from '../styles';
import { buildDescribedBy } from '@/components/ui/form-field';

interface HouseRulesStepProps {
  formData: Partial<ListingFormData>;
  setFormData: (data: Partial<ListingFormData>) => void;
  errors: Record<string, string>;
}

interface RuleToggleProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

/**
 * Toggle-style checkbox.
 *
 * The label wraps both the checkbox and the descriptive text so the entire
 * row is clickable.  The description is rendered as a visible <span> so
 * screen readers can associate it with the control without requiring a
 * separate aria-describedby.
 */
function RuleToggle({ id, label, description, checked, onChange }: RuleToggleProps) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-4 p-4 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 transition"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      <div>
        <span className="block font-medium text-gray-900">{label}</span>
        <span className="block text-sm text-gray-500">{description}</span>
      </div>
    </label>
  );
}

export default function HouseRulesStep({ formData, setFormData, errors }: HouseRulesStepProps) {
  const update = (patch: Partial<ListingFormData>) =>
    setFormData({ ...formData, ...patch });

  const quietEnabled = !!(formData.quietHoursStart || formData.quietHoursEnd);

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Let tenants know the rules before they book. These will be shown on the listing
        and tenants must acknowledge them.
      </p>

      {/* Boolean rule flags */}
      <fieldset>
        <legend className="text-sm font-semibold text-gray-700 mb-3">Property rules</legend>
        <div className="space-y-3">
          <RuleToggle
            id="rule-petsAllowed"
            label="Pets allowed"
            description="Guests may bring well-behaved pets."
            checked={formData.petsAllowed ?? false}
            onChange={(v) => update({ petsAllowed: v })}
          />
          <RuleToggle
            id="rule-smokingAllowed"
            label="Smoking allowed"
            description="Guests may smoke on the property."
            checked={formData.smokingAllowed ?? false}
            onChange={(v) => update({ smokingAllowed: v })}
          />
          <RuleToggle
            id="rule-eventsAllowed"
            label="Events / parties allowed"
            description="Guests may host gatherings or events."
            checked={formData.eventsAllowed ?? false}
            onChange={(v) => update({ eventsAllowed: v })}
          />
        </div>
      </fieldset>

      {/* Quiet hours */}
      <fieldset className="border border-gray-200 rounded-lg p-4 space-y-3">
        <legend className="text-sm font-semibold text-gray-900 px-1">Quiet hours</legend>
        <p id="quiet-hours-hint" className="text-sm text-gray-500">
          Leave both fields empty if there are no quiet hours.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className={formStyles.formGroup}>
            <label htmlFor="quietHoursStart" className={formStyles.label}>
              Start
            </label>
            <input
              id="quietHoursStart"
              type="time"
              value={formData.quietHoursStart ?? ''}
              onChange={(e) => update({ quietHoursStart: e.target.value })}
              aria-describedby="quiet-hours-hint"
              className={formStyles.input}
            />
          </div>
          <div className={formStyles.formGroup}>
            <label htmlFor="quietHoursEnd" className={formStyles.label}>
              End
            </label>
            <input
              id="quietHoursEnd"
              type="time"
              value={formData.quietHoursEnd ?? ''}
              onChange={(e) => update({ quietHoursEnd: e.target.value })}
              aria-describedby="quiet-hours-hint"
              className={formStyles.input}
            />
          </div>
        </div>
        {quietEnabled && (
          <p className="text-xs text-blue-700 bg-blue-50 px-3 py-2 rounded" aria-live="polite">
            Quiet hours: {formData.quietHoursStart || '—'} → {formData.quietHoursEnd || '—'}
          </p>
        )}
      </fieldset>

      {/* Additional rules */}
      <div className={formStyles.formGroup}>
        <label htmlFor="additionalRules" className={formStyles.label}>
          Additional rules
          <span className="ml-1 font-normal text-gray-400">(optional)</span>
        </label>
        <textarea
          id="additionalRules"
          rows={4}
          value={formData.additionalRules ?? ''}
          onChange={(e) => update({ additionalRules: e.target.value })}
          placeholder="e.g. No shoes indoors, take trash out before checkout…"
          maxLength={2000}
          aria-invalid={!!errors.additionalRules || undefined}
          aria-describedby={buildDescribedBy('additionalRules', !!errors.additionalRules, true)}
          className={errors.additionalRules ? formStyles.textareaError : formStyles.textarea}
        />
        <p
          id="additionalRules-hint"
          className="text-xs text-gray-400 text-right mt-1"
          aria-live="polite"
        >
          {(formData.additionalRules ?? '').length} / 2000
        </p>
        {errors.additionalRules && (
          <p
            id="additionalRules-error"
            role="alert"
            aria-live="polite"
            className={formStyles.error}
          >
            {errors.additionalRules}
          </p>
        )}
      </div>
    </div>
  );
}
