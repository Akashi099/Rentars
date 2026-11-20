import { useListingForm } from '@/hooks/use-listing-form';
import { act, renderHook } from '@testing-library/react';
/**
 * Draft restore flow in the listing form hook (#919).
 * The prompt is offered, never applied silently. Dismissing keeps the draft. Resuming
 * drops photos. Autosave does not overwrite a saved draft before the host decides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_SCHEMA_VERSION, draftKeyFor } from '../draft';

const OWNER = 'GOWNER111';

function seedDraft(savedAt: number, formData: Record<string, unknown> = { title: 'Saved loft' }) {
  localStorage.setItem(
    draftKeyFor(OWNER)!,
    JSON.stringify({
      schemaVersion: DRAFT_SCHEMA_VERSION,
      ownerKey: OWNER,
      savedAt,
      currentStep: 'pricing',
      formData,
    })
  );
}

describe('useListingForm — draft restore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('offers a valid draft without applying it', () => {
    seedDraft(Date.now() - 60_000);
    const { result } = renderHook(() => useListingForm(OWNER));

    expect(result.current.draftDialogOpen).toBe(true);
    expect(result.current.pendingDraft?.formData.title).toBe('Saved loft');
    expect(result.current.formData.title).toBeUndefined();
    expect(result.current.currentStep).toBe('basic');
  });

  it('dismissing the prompt keeps the draft and does not overwrite it', () => {
    seedDraft(Date.now() - 60_000);
    const { result } = renderHook(() => useListingForm(OWNER));

    act(() => result.current.dismissDraftDialog());
    // Let autosave run: it must stay paused while the decision is pending.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    const stored = JSON.parse(localStorage.getItem(draftKeyFor(OWNER)!)!);
    expect(stored.formData.title).toBe('Saved loft');
    expect(result.current.hasPendingDraft).toBe(true);
    expect(result.current.draftDialogOpen).toBe(false);
  });

  it('resuming applies the draft, sets the step, and drops photos', () => {
    seedDraft(Date.now() - 60_000, { title: 'Saved loft', images: [] });
    const { result } = renderHook(() => useListingForm(OWNER));

    act(() => result.current.resumeDraft());

    expect(result.current.formData.title).toBe('Saved loft');
    expect(result.current.formData.images).toEqual([]);
    expect(result.current.currentStep).toBe('pricing');
    expect(result.current.restoredNeedsAttention).toContain('photos');
    expect(result.current.hasPendingDraft).toBe(false);
  });

  it('discarding removes the stored draft', () => {
    seedDraft(Date.now() - 60_000);
    const { result } = renderHook(() => useListingForm(OWNER));

    act(() => result.current.discardDraft());

    expect(localStorage.getItem(draftKeyFor(OWNER)!)).toBeNull();
    expect(result.current.hasPendingDraft).toBe(false);
  });

  it('removes an expired draft and says so, instead of offering it', () => {
    seedDraft(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const { result } = renderHook(() => useListingForm(OWNER));

    expect(result.current.hasPendingDraft).toBe(false);
    expect(result.current.notice).toMatch(/older than 14 days/);
    expect(localStorage.getItem(draftKeyFor(OWNER)!)).toBeNull();
  });

  it('saves nothing when the host is not identified', () => {
    const { result } = renderHook(() => useListingForm(null));

    act(() => result.current.setFormData({ title: 'No owner' }));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(localStorage.length).toBe(0);
  });

  it('autosaves for an identified host once there is no pending decision', () => {
    const { result } = renderHook(() => useListingForm(OWNER));

    act(() => result.current.setFormData({ title: 'Fresh draft' }));
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    const stored = JSON.parse(localStorage.getItem(draftKeyFor(OWNER)!)!);
    expect(stored.formData.title).toBe('Fresh draft');
    expect(stored.ownerKey).toBe(OWNER);
  });

  it('keeps each host’s draft separate', () => {
    seedDraft(Date.now() - 60_000, { title: 'Owner A draft' });
    const { result } = renderHook(() => useListingForm('GOTHER222'));

    expect(result.current.hasPendingDraft).toBe(false);
  });
});
