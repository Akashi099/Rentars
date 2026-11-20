/**
 * Listing draft lifecycle (#919).
 *
 * A draft is local, per-host progress on a listing that is not yet published. This
 * module decides what is stored, whose it is, when it expires, and what is safe to
 * restore. It never publishes anything: restoring a draft only refills the form.
 *
 * Guarantees:
 *  - Drafts are keyed by the host's wallet public key, so one host's draft never
 *    overwrites another's on a shared browser.
 *  - Each draft carries a schema version. Unknown or older layouts are not restored.
 *  - Drafts expire after DRAFT_TTL_MS.
 *  - Uploaded File objects cannot survive JSON. Photos are never persisted, and the
 *    restore reports that they must be added again.
 *  - Every restored value is checked against its expected type. Anything that does
 *    not fit is dropped and named in `needsAttention`, so the host reviews it.
 */

import type { ListingFormData, ListingStep } from './types';

export const DRAFT_SCHEMA_VERSION = 2;
export const DRAFT_KEY_PREFIX = 'listing_form_draft:v2:';
/** The pre-#919 global key. It is not restored, because it cannot be tied to an owner. */
export const LEGACY_DRAFT_KEY = 'listing_form_draft';
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export const LISTING_STEPS: readonly ListingStep[] = [
  'basic',
  'location',
  'amenities',
  'photos',
  'pricing',
  'rules',
  'review',
];

export const STEP_LABELS: Record<ListingStep, string> = {
  basic: 'Basic Info',
  location: 'Location',
  amenities: 'Amenities',
  photos: 'Photos',
  pricing: 'Pricing',
  rules: 'House Rules',
  review: 'Review',
};

/** Everything except photos, which are not serialisable. */
export type DraftFormData = Partial<Omit<ListingFormData, 'images'>>;

type FieldKind = 'string' | 'number' | 'nullableNumber' | 'boolean' | 'stringArray';

const FIELD_KINDS: Record<keyof DraftFormData, FieldKind> = {
  title: 'string',
  description: 'string',
  propertyType: 'string',
  address: 'string',
  city: 'string',
  state: 'string',
  zipCode: 'string',
  country: 'string',
  latitude: 'number',
  longitude: 'number',
  maxGuests: 'number',
  bedrooms: 'number',
  bathrooms: 'number',
  amenities: 'stringArray',
  pricePerNight: 'number',
  cleaningFee: 'number',
  serviceFee: 'number',
  minNights: 'number',
  maxNights: 'nullableNumber',
  checkInTime: 'string',
  checkOutTime: 'string',
  petsAllowed: 'boolean',
  smokingAllowed: 'boolean',
  eventsAllowed: 'boolean',
  quietHoursStart: 'string',
  quietHoursEnd: 'string',
  additionalRules: 'string',
  agreeToTerms: 'boolean',
};

const KNOWN_STEPS = new Set<string>(LISTING_STEPS);

export interface StoredDraft {
  schemaVersion: number;
  ownerKey: string;
  savedAt: number;
  currentStep: ListingStep;
  formData: DraftFormData;
}

export interface RestoredDraft {
  formData: DraftFormData;
  currentStep: ListingStep;
  savedAt: number;
  /** Field names, or 'photos', that the host must review before submitting. */
  needsAttention: string[];
}

export type DraftLoadResult =
  | { status: 'none' }
  | { status: 'expired'; savedAt: number }
  | { status: 'unreadable' }
  | { status: 'ok'; draft: RestoredDraft };

/** Storage key for an owner's draft, or null when the host is not identified. */
export function draftKeyFor(ownerKey: string | null | undefined): string | null {
  const trimmed = ownerKey?.trim();
  return trimmed ? `${DRAFT_KEY_PREFIX}${trimmed}` : null;
}

/** Keeps only the fields the draft knows about, and never keeps photos. */
export function toDraftFormData(data: Partial<ListingFormData>): DraftFormData {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(FIELD_KINDS) as (keyof DraftFormData)[]) {
    const value = data[key];
    if (value !== undefined) out[key] = value;
  }
  return out as DraftFormData;
}

export function serializeDraft(input: {
  ownerKey: string;
  currentStep: ListingStep;
  formData: Partial<ListingFormData>;
  now: number;
}): string {
  const stored: StoredDraft = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    ownerKey: input.ownerKey,
    savedAt: input.now,
    currentStep: input.currentStep,
    formData: toDraftFormData(input.formData),
  };
  return JSON.stringify(stored);
}

function valueFits(kind: FieldKind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'nullableNumber':
      return value === null || (typeof value === 'number' && Number.isFinite(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'stringArray':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
  }
}

/**
 * Checks each stored field against its expected type. Fields that do not fit are
 * dropped and reported. Unknown keys are dropped silently.
 */
export function sanitizeRestoredFields(raw: Record<string, unknown>): {
  formData: DraftFormData;
  needsAttention: string[];
} {
  const formData: Record<string, unknown> = {};
  const needsAttention: string[] = [];
  for (const key of Object.keys(FIELD_KINDS) as (keyof DraftFormData)[]) {
    if (!(key in raw) || raw[key] === undefined) continue;
    if (valueFits(FIELD_KINDS[key], raw[key])) {
      formData[key] = raw[key];
    } else {
      needsAttention.push(key);
    }
  }
  return { formData: formData as DraftFormData, needsAttention };
}

export function isDraftExpired(savedAt: number, now: number): boolean {
  return now - savedAt > DRAFT_TTL_MS;
}

/**
 * Interprets the raw localStorage value for one owner.
 * Never throws: a corrupt entry is reported as 'unreadable' and nothing is restored from it.
 */
export function loadDraft(raw: string | null, ownerKey: string, now: number): DraftLoadResult {
  if (!raw) return { status: 'none' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'unreadable' };

  const candidate = parsed as Partial<StoredDraft> & Record<string, unknown>;
  if (candidate.schemaVersion !== DRAFT_SCHEMA_VERSION) return { status: 'unreadable' };
  if (candidate.ownerKey !== ownerKey) return { status: 'unreadable' };
  if (typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt)) {
    return { status: 'unreadable' };
  }
  if (isDraftExpired(candidate.savedAt, now)) {
    return { status: 'expired', savedAt: candidate.savedAt };
  }

  const formRaw =
    candidate.formData && typeof candidate.formData === 'object'
      ? (candidate.formData as Record<string, unknown>)
      : {};
  const { formData, needsAttention } = sanitizeRestoredFields(formRaw);

  const step =
    typeof candidate.currentStep === 'string' && KNOWN_STEPS.has(candidate.currentStep)
      ? (candidate.currentStep as ListingStep)
      : 'basic';
  if (step !== candidate.currentStep) needsAttention.push('currentStep');

  // Photos are never stored, so the host always adds them again.
  needsAttention.push('photos');

  return {
    status: 'ok',
    draft: { formData, currentStep: step, savedAt: candidate.savedAt, needsAttention },
  };
}

/** One line for the restore dialog: when it was saved and how far the host got. */
export function summarizeDraft(draft: RestoredDraft, now: number): string {
  const minutes = Math.max(0, Math.round((now - draft.savedAt) / 60_000));
  const when =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 60 * 24
          ? `${Math.round(minutes / 60)} h ago`
          : `${Math.round(minutes / (60 * 24))} day(s) ago`;
  const index = LISTING_STEPS.indexOf(draft.currentStep);
  return `Saved ${when}, on step ${index + 1} of ${LISTING_STEPS.length} (${STEP_LABELS[draft.currentStep]}).`;
}

// ── Storage wrappers ─────────────────────────────────────────────────────────

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Reads the owner's draft. Storage errors (private mode, blocked) mean no draft. */
export function readDraft(
  storage: KeyValueStorage | null | undefined,
  ownerKey: string | null | undefined,
  now: number
): DraftLoadResult {
  const key = draftKeyFor(ownerKey);
  if (!storage || !key || !ownerKey) return { status: 'none' };
  try {
    return loadDraft(storage.getItem(key), ownerKey.trim(), now);
  } catch {
    return { status: 'none' };
  }
}

export function writeDraft(
  storage: KeyValueStorage | null | undefined,
  input: {
    ownerKey: string | null | undefined;
    currentStep: ListingStep;
    formData: Partial<ListingFormData>;
    now: number;
  }
): boolean {
  const key = draftKeyFor(input.ownerKey);
  if (!storage || !key || !input.ownerKey) return false;
  try {
    storage.setItem(
      key,
      serializeDraft({
        ownerKey: input.ownerKey.trim(),
        currentStep: input.currentStep,
        formData: input.formData,
        now: input.now,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(
  storage: KeyValueStorage | null | undefined,
  ownerKey: string | null | undefined
): void {
  const key = draftKeyFor(ownerKey);
  if (!storage || !key) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing else to do: the draft is still expired by its timestamp.
  }
}
