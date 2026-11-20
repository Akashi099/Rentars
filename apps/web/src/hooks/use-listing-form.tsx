'use client';

import {
  type DraftLoadResult,
  LISTING_STEPS,
  type RestoredDraft,
  clearDraft as clearStoredDraft,
  readDraft,
  writeDraft,
} from '@/components/properties/ListingForm/draft';
import type { ListingFormData, ListingStep } from '@/components/properties/ListingForm/types';
import { useCallback, useEffect, useRef, useState } from 'react';

const DRAFT_SAVE_DEBOUNCE_MS = 1000;

type FormState = Partial<ListingFormData>;

function getBrowserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The listing form's state, plus its draft lifecycle (#919).
 *
 * - Draft owner is the host's wallet key. With no key, nothing is saved.
 * - On mount, a valid draft is offered, never applied silently. Autosave is paused
 *   until the host decides, so an unanswered prompt cannot overwrite the saved draft.
 * - Dismissing the prompt keeps the draft. Discarding removes it. Publishing removes it.
 */
export function useListingForm(ownerKey: string | null = null) {
  const [currentStep, setCurrentStep] = useState<ListingStep>('basic');
  const [formData, setFormDataState] = useState<FormState>({
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
    // Defaults the pricing step shows, so validation sees the same values the host sees.
    minNights: 1,
    maxNights: null,
    checkInTime: '15:00',
    checkOutTime: '11:00',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDraft, setPendingDraft] = useState<RestoredDraft | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoredNeedsAttention, setRestoredNeedsAttention] = useState<string[]>([]);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentStepIndex = LISTING_STEPS.indexOf(currentStep);

  // Look for a draft once the owner is known.
  useEffect(() => {
    const storage = getBrowserStorage();
    if (!ownerKey) return;
    const result: DraftLoadResult = readDraft(storage, ownerKey, Date.now());
    if (result.status === 'ok') {
      setPendingDraft(result.draft);
      setDialogOpen(true);
    } else if (result.status === 'expired') {
      clearStoredDraft(storage, ownerKey);
      setNotice('A saved draft older than 14 days was removed.');
    }
  }, [ownerKey]);

  // Autosave, debounced, once there is no unanswered prompt.
  useEffect(() => {
    if (!ownerKey || pendingDraft) return;
    const storage = getBrowserStorage();
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      writeDraft(storage, { ownerKey, currentStep, formData, now: Date.now() });
    }, DRAFT_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [ownerKey, pendingDraft, currentStep, formData]);

  const setFormData = useCallback((data: FormState) => {
    setFormDataState(data);
  }, []);

  /** Merges a partial update into the form. Kept alongside setFormData for existing callers. */
  const updateFormData = useCallback((data: FormState) => {
    setFormDataState((prev) => ({ ...prev, ...data }));
  }, []);

  const goToStep = useCallback((step: ListingStep) => setCurrentStep(step), []);

  const nextStep = useCallback(() => {
    setCurrentStep((step) => {
      const i = LISTING_STEPS.indexOf(step);
      return i < LISTING_STEPS.length - 1 ? LISTING_STEPS[i + 1] : step;
    });
  }, []);

  const previousStep = useCallback(() => {
    setCurrentStep((step) => {
      const i = LISTING_STEPS.indexOf(step);
      return i > 0 ? LISTING_STEPS[i - 1] : step;
    });
  }, []);

  const resumeDraft = useCallback(() => {
    if (!pendingDraft) return;
    // Photos are never restored. They are listed in needsAttention for the host to add again.
    setFormDataState({ ...pendingDraft.formData, images: [] });
    setCurrentStep(pendingDraft.currentStep);
    setRestoredNeedsAttention(pendingDraft.needsAttention);
    setPendingDraft(null);
    setDialogOpen(false);
  }, [pendingDraft]);

  const discardDraft = useCallback(() => {
    clearStoredDraft(getBrowserStorage(), ownerKey);
    setPendingDraft(null);
    setDialogOpen(false);
    setRestoredNeedsAttention([]);
  }, [ownerKey]);

  /** Hides the prompt but keeps the draft. The host can resume it later from the banner. */
  const dismissDraftDialog = useCallback(() => setDialogOpen(false), []);
  const reopenDraftDialog = useCallback(() => {
    if (pendingDraft) setDialogOpen(true);
  }, [pendingDraft]);

  /** Call after a successful publish. */
  const clearDraft = useCallback(() => {
    clearStoredDraft(getBrowserStorage(), ownerKey);
    setPendingDraft(null);
    setRestoredNeedsAttention([]);
  }, [ownerKey]);

  const setError = useCallback((field: string, message: string) => {
    setErrors((prev) => ({ ...prev, [field]: message }));
  }, []);

  const clearError = useCallback((field: string) => {
    setErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  return {
    currentStep,
    currentStepIndex,
    formData,
    setFormData,
    updateFormData,
    errors,
    setErrors,
    setError,
    clearError,
    goToStep,
    nextStep,
    previousStep,
    pendingDraft,
    draftDialogOpen: dialogOpen && !!pendingDraft,
    hasPendingDraft: !!pendingDraft,
    hasDraft: !!pendingDraft,
    notice,
    dismissNotice: () => setNotice(null),
    restoredNeedsAttention,
    resumeDraft,
    discardDraft,
    dismissDraftDialog,
    reopenDraftDialog,
    clearDraft,
  };
}
