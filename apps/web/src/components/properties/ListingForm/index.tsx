'use client';

import { useRef, useState } from 'react';
import type { ListingFormData, ListingStep } from './types';
import { formStyles } from './styles';
import BasicInfoStep from './steps/BasicInfoStep';
import LocationStep from './steps/LocationStep';
import AmenitiesStep from './steps/AmenitiesStep';
import PhotosStep from './steps/PhotosStep';
import PricingStep from './steps/PricingStep';
import HouseRulesStep from './steps/HouseRulesStep';
import ReviewStep from './steps/ReviewStep';
import { TermsDisclosure, type TermsAcceptance } from '@/components/shared/TermsDisclosure';
import { useFormErrorFocus } from '@/hooks/useFormErrorFocus';

const STEPS: ListingStep[] = [
  'basic',
  'location',
  'amenities',
  'photos',
  'pricing',
  'rules',
  'review',
];

const STEP_LABELS: Record<ListingStep, string> = {
  basic: 'Basic Info',
  location: 'Location',
  amenities: 'Amenities',
  photos: 'Photos',
  pricing: 'Pricing',
  rules: 'House Rules',
  review: 'Review',
};

export default function ListingForm() {
  const [currentStep, setCurrentStep] = useState<ListingStep>('basic');
  const [formData, setFormData] = useState<Partial<ListingFormData>>({
    amenities: [],
    images: [],
    maxGuests: 1,
    bedrooms: 0,
    bathrooms: 0,
    petsAllowed: false,
    smokingAllowed: false,
    eventsAllowed: false,
    quietHoursStart: '',
    quietHoursEnd: '',
    additionalRules: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uploadsInProgress, setUploadsInProgress] = useState(false);
  const [termsAcceptance, setTermsAcceptance] = useState<TermsAcceptance | null>(null);
  const submitErrorRef = useRef<HTMLParagraphElement | null>(null);
  const { focusFirstError } = useFormErrorFocus();

  const currentStepIndex = STEPS.indexOf(currentStep);

  const handleNext = () => {
    if (currentStepIndex < STEPS.length - 1) {
      setCurrentStep(STEPS[currentStepIndex + 1]);
    }
  };

  const handlePrevious = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(STEPS[currentStepIndex - 1]);
    }
  };

  const handleSubmit = async () => {
    if (!termsAcceptance) {
      setErrors({ submit: 'You must accept the platform terms before publishing your listing.' });
      // Focus the error message so screen readers announce it immediately
      setTimeout(() => submitErrorRef.current?.focus(), 50);
      return;
    }

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      const token = localStorage.getItem('token');

      const formDataToSend = new FormData();
      Object.entries(formData).forEach(([key, value]) => {
        if (key === 'images' && Array.isArray(value)) {
          value.forEach((file) => formDataToSend.append('images', file));
        } else if (key === 'amenities' && Array.isArray(value)) {
          formDataToSend.append('amenities', JSON.stringify(value));
        } else if (typeof value === 'boolean') {
          formDataToSend.append(key, String(value));
        } else if (value !== undefined) {
          formDataToSend.append(key, String(value));
        }
      });
      formDataToSend.append('terms_version', termsAcceptance.termsVersion);
      formDataToSend.append('terms_accepted_at', termsAcceptance.termsAcceptedAt);

      const response = await fetch(`${API_URL}/api/properties`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formDataToSend,
      });

      if (!response.ok) throw new Error('Failed to create listing');

      const property = await response.json();

      if (window.freighter) {
        await window.freighter.signTransaction({
          xdr: property.xdr,
          publicKey: localStorage.getItem('publicKey'),
        });
      }

      alert('Property listed successfully!');
      window.location.href = '/dashboard';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit';
      setErrors({ submit: message });
      setTimeout(() => submitErrorRef.current?.focus(), 50);
    }
  };

  return (
    <div className={formStyles.container}>
      {/*
       * Step indicator — each dot has a visually-hidden label so screen-reader
       * users know their position in the multi-step form.
       */}
      <nav aria-label="Form steps" className={formStyles.stepIndicator}>
        {STEPS.map((step, index) => (
          <span
            key={step}
            role="img"
            aria-label={`Step ${index + 1} of ${STEPS.length}: ${STEP_LABELS[step]}${
              step === currentStep
                ? ' (current)'
                : index < currentStepIndex
                  ? ' (completed)'
                  : ''
            }`}
            aria-current={step === currentStep ? 'step' : undefined}
            className={`${formStyles.step} ${
              index <= currentStepIndex ? formStyles.stepActive : formStyles.stepInactive
            }`}
          />
        ))}
      </nav>

      <div className={formStyles.section}>
        <h2 className={formStyles.heading} id="listing-step-heading">
          {`Step ${currentStepIndex + 1} of ${STEPS.length}: ${STEP_LABELS[currentStep]}`}
        </h2>

        {/* Submit / server error — focusable so screen readers are notified */}
        {errors.submit && (
          <p
            ref={submitErrorRef}
            id="listing-submit-error"
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {errors.submit}
          </p>
        )}

        {currentStep === 'basic' && (
          <BasicInfoStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'location' && (
          <LocationStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'amenities' && (
          <AmenitiesStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'photos' && (
          <PhotosStep
            formData={formData}
            setFormData={setFormData}
            errors={errors}
            onUploadStatusChange={setUploadsInProgress}
          />
        )}
        {currentStep === 'pricing' && (
          <PricingStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'rules' && (
          <HouseRulesStep formData={formData} setFormData={setFormData} errors={errors} />
        )}
        {currentStep === 'review' && (
          <ReviewStep formData={formData} errors={errors} />
        )}

        {currentStep === 'review' && (
          <div className="mt-6">
            <TermsDisclosure
              variant="listing"
              accepted={!!termsAcceptance}
              onAcceptanceChange={setTermsAcceptance}
            />
          </div>
        )}

        {/* Navigation — type="button" prevents accidental form submission */}
        <div className="flex gap-4 mt-8">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={currentStepIndex === 0}
            aria-label={
              currentStepIndex > 0
                ? `Go back to ${STEP_LABELS[STEPS[currentStepIndex - 1]]}`
                : 'Already on first step'
            }
            className={`${formStyles.button} ${formStyles.buttonSecondary} disabled:opacity-50`}
          >
            Previous
          </button>

          {currentStepIndex < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={handleNext}
              disabled={currentStep === 'photos' && uploadsInProgress}
              aria-label={`Continue to ${STEP_LABELS[STEPS[currentStepIndex + 1]]}`}
              aria-busy={currentStep === 'photos' && uploadsInProgress}
              className={`${formStyles.button} ${formStyles.buttonPrimary} ${
                currentStep === 'photos' && uploadsInProgress ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {currentStep === 'photos' && uploadsInProgress ? 'Uploading…' : 'Next'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!termsAcceptance}
              aria-disabled={!termsAcceptance}
              className={`${formStyles.button} ${formStyles.buttonPrimary} ${
                !termsAcceptance ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Submit Listing
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
