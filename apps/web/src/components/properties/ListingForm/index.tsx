'use client';

import { type TermsAcceptance, TermsDisclosure } from '@/components/shared/TermsDisclosure';
import { useListingForm } from '@/hooks/use-listing-form';
import { useFormErrorFocus } from '@/hooks/useFormErrorFocus';
import { useEffect, useRef, useState } from 'react';
import DraftRestoreDialog from './DraftRestoreDialog';
import { LISTING_STEPS, STEP_LABELS, summarizeDraft } from './draft';
import AmenitiesStep from './steps/AmenitiesStep';
import BasicInfoStep from './steps/BasicInfoStep';
import HouseRulesStep from './steps/HouseRulesStep';
import LocationStep from './steps/LocationStep';
import PhotosStep from './steps/PhotosStep';
import PricingStep from './steps/PricingStep';
import ReviewStep from './steps/ReviewStep';
import { formStyles } from './styles';
import type { ListingFormData, ListingStep } from './types';
import { apiErrorsToFormErrors, toApiPayload, validateListing, validateStep } from './validation';

const STEPS: ListingStep[] = LISTING_STEPS as ListingStep[];

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  description: 'description',
  propertyType: 'property type',
  address: 'address',
  city: 'city',
  country: 'country',
  latitude: 'latitude',
  longitude: 'longitude',
  pricePerNight: 'price per night',
  minNights: 'minimum stay',
  maxNights: 'maximum stay',
  checkInTime: 'check-in time',
  checkOutTime: 'check-out time',
  amenities: 'amenities',
  images: 'photos',
};

export default function ListingForm() {
  const {
    currentStep,
    currentStepIndex,
    formData,
    setFormData,
    errors,
    setErrors,
    goToStep,
    nextStep,
    previousStep,
    hasPendingDraft,
    draftDialogOpen,
    pendingDraft,
    notice,
    dismissNotice,
    restoredNeedsAttention,
    resumeDraft,
    discardDraft,
    dismissDraftDialog,
    reopenDraftDialog,
    clearDraft,
  } = useListingForm(useStoredOwnerKey());

  const [uploadsInProgress, setUploadsInProgress] = useState(false);
  const [termsAcceptance, setTermsAcceptance] = useState<TermsAcceptance | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Set once the listing exists, so a retry after a photo failure never creates a second listing. */
  const [createdListing, setCreatedListing] = useState<{
    id: string;
    xdr?: string;
    signed: boolean;
  } | null>(null);
  const [failedPhotos, setFailedPhotos] = useState<File[]>([]);
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  const submitErrorRef = useRef<HTMLParagraphElement | null>(null);
  const { focusFirstError } = useFormErrorFocus();

  const focusErrorSoon = () => setTimeout(() => focusFirstError(), 50);

  const handleNext = () => {
    const stepErrors = validateStep(currentStep, formData);
    if (Object.keys(stepErrors).length > 0) {
      // Invalid required data: the host stays on this step and sees each message.
      setErrors(stepErrors);
      focusErrorSoon();
      return;
    }
    setErrors({});
    nextStep();
  };

  const handlePrevious = () => {
    setErrors({});
    previousStep();
  };

  const uploadPhotos = async (listingId: string, files: File[], token: string, apiUrl: string) => {
    const failed: File[] = [];
    let lastError = '';
    for (const file of files) {
      try {
        const body = new FormData();
        body.append('image', file);
        const res = await fetch(`${apiUrl}/api/v1/properties/${listingId}/images`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `Upload failed (${res.status})`);
        }
      } catch (err) {
        failed.push(file);
        lastError = err instanceof Error ? err.message : 'Upload failed';
      }
    }
    return { failed, lastError };
  };

  const handleSubmit = async () => {
    setErrors({});
    setPhotoProblem(null);

    // Full re-validation, because a restored draft or an earlier step may be stale.
    // Terms acceptance lives outside the form data, so it is passed in here.
    const { errors: allErrors, firstInvalidStep } = validateListing({
      ...formData,
      agreeToTerms: termsAcceptance !== null,
    });
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      if (firstInvalidStep) goToStep(firstInvalidStep);
      focusErrorSoon();
      return;
    }

    // Validation above already requires terms; this narrows the type for the request below.
    if (!termsAcceptance) return;

    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
    const token = localStorage.getItem('token') ?? '';
    setSubmitting(true);

    try {
      // 1. Create the listing once. A retry reuses it, so no second listing is made.
      let listing = createdListing;
      // Photos still to upload. A fresh submit takes them from the form; a retry takes the failed ones.
      let pending: File[] = failedPhotos;
      if (!listing) {
        const res = await fetch(`${apiUrl}/api/v1/properties`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...toApiPayload(formData),
            terms_version: termsAcceptance.termsVersion,
            terms_accepted_at: termsAcceptance.termsAcceptedAt,
          }),
        });

        if (res.status === 422) {
          const data = (await res.json()) as { fields?: Record<string, string[]> };
          const mapped = apiErrorsToFormErrors(data.fields ?? {});
          setErrors({
            ...mapped.errors,
            submit: 'Some details were rejected. Check the highlighted fields.',
          });
          if (mapped.firstInvalidStep) goToStep(mapped.firstInvalidStep);
          focusErrorSoon();
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? 'Failed to create listing');
        }

        const property = (await res.json()) as { id: string; xdr?: string };
        listing = { id: property.id, xdr: property.xdr, signed: false };
        setCreatedListing(listing);
        pending = formData.images ?? [];
        // Every photo is pending until the server confirms it.
        setFailedPhotos(pending);
      }

      // 2. Sign on-chain once. Skipped when no wallet is available.
      if (!listing.signed && window.freighter && listing.xdr) {
        await window.freighter.signTransaction({
          xdr: listing.xdr,
          publicKey: localStorage.getItem('publicKey'),
        });
        listing = { ...listing, signed: true };
        setCreatedListing(listing);
      }

      // 3. Upload the pending photos one by one. Only failures are retried.
      const { failed, lastError } = await uploadPhotos(listing.id, pending, token, apiUrl);
      setFailedPhotos(failed);

      if (failed.length > 0) {
        const uploaded = pending.length - failed.length;
        const uploadedNote = uploaded > 0 ? ` (${uploaded} uploaded)` : '';
        setPhotoProblem(
          `Your listing was created, but ${failed.length} of ${pending.length} photo(s) did not upload${uploadedNote}: ${lastError}. Press "Retry photo upload" to try the failed photos again.`
        );
        setTimeout(() => submitErrorRef.current?.focus(), 50);
        return;
      }

      clearDraft();
      alert('Property listed successfully!');
      window.location.href = '/dashboard';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit';
      setErrors({ submit: message });
      setTimeout(() => submitErrorRef.current?.focus(), 50);
    } finally {
      setSubmitting(false);
    }
  };

  const retryNeeded = createdListing !== null && failedPhotos.length > 0;

  return (
    <div className={formStyles.container}>
      {notice && (
        <output className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <span>{notice}</span>
          <button type="button" onClick={dismissNotice} className="underline">
            Dismiss
          </button>
        </output>
      )}

      {hasPendingDraft && !draftDialogOpen && (
        <output className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          <span>
            You have a saved draft
            {pendingDraft ? `. ${summarizeDraft(pendingDraft, Date.now())}` : ''}
          </span>
          <span className="flex gap-3">
            <button type="button" onClick={resumeDraft} className="underline font-semibold">
              Resume
            </button>
            <button type="button" onClick={discardDraft} className="underline">
              Discard
            </button>
          </span>
        </output>
      )}

      {restoredNeedsAttention.length > 0 && (
        <output className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Please review your restored draft</p>
          <p>
            These need your attention before you submit:{' '}
            {restoredNeedsAttention
              .filter((f) => f !== 'photos' && f !== 'currentStep')
              .map((f) => FIELD_LABELS[f] ?? f)
              .concat(['photos'])
              .join(', ')}
            .
          </p>
        </output>
      )}

      <DraftRestoreDialog
        hasDraft={hasPendingDraft}
        isOpen={draftDialogOpen}
        summary={pendingDraft ? summarizeDraft(pendingDraft, Date.now()) : undefined}
        onResume={resumeDraft}
        onDiscard={discardDraft}
        onDismiss={dismissDraftDialog}
      />

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
              step === currentStep ? ' (current)' : index < currentStepIndex ? ' (completed)' : ''
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
        {(errors.submit || photoProblem) && (
          <p
            ref={submitErrorRef}
            id="listing-submit-error"
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            {photoProblem ?? errors.submit}
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
        {currentStep === 'review' && <ReviewStep formData={formData} errors={errors} />}

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
              disabled={!termsAcceptance || submitting}
              aria-disabled={!termsAcceptance || submitting}
              className={`${formStyles.button} ${formStyles.buttonPrimary} ${
                !termsAcceptance || submitting ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {submitting ? 'Submitting…' : retryNeeded ? 'Retry photo upload' : 'Submit Listing'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The host's wallet key, which owns the draft. Read after mount, so server rendering is safe. */
function useStoredOwnerKey(): string | null {
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    try {
      setKey(localStorage.getItem('publicKey'));
    } catch {
      setKey(null);
    }
  }, []);
  return key;
}
