/**
 * Saved-search normalisation, shareable links, and alert timing rules
 * (issue #751).
 *
 * Filters are normalised into one canonical, versioned shape before they are
 * stored, so two searches that mean the same thing compare equal and a saved
 * link restores exactly the filters that were saved.
 */

export const SAVED_SEARCH_FILTER_VERSION = 1;

export type DigestFrequency = 'immediate' | 'daily' | 'weekly';

const FREQUENCY_WINDOW_MS: Record<DigestFrequency, number> = {
  immediate: 0,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export interface NormalizedSavedSearchFilters {
  query?: string;
  city?: string;
  country?: string;
  checkIn?: string;
  checkOut?: string;
  min_price?: number;
  max_price?: number;
  bedrooms?: number;
  min_bathrooms?: number;
  guests?: number;
  amenities?: string[];
  property_types?: string[];
}

export interface VersionedSavedSearchFilters {
  version: number;
  filters: NormalizedSavedSearchFilters;
}

const NUMERIC_KEYS = ['min_price', 'max_price', 'bedrooms', 'min_bathrooms', 'guests'] as const;
const LOWERCASE_STRING_KEYS = ['city', 'country'] as const;
const LIST_KEYS = ['amenities', 'property_types'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise raw saved-search filters. Unknown keys are dropped, empty values
 * are removed, numbers must be finite, dates must be YYYY-MM-DD, and list
 * values are trimmed, lower-cased, de-duplicated and sorted.
 */
export function normalizeSavedSearchFilters(
  raw: Record<string, unknown>
): VersionedSavedSearchFilters {
  const filters: NormalizedSavedSearchFilters = {};

  const query = collapseSpaces(raw.query);
  if (query) filters.query = query.toLowerCase();

  for (const key of LOWERCASE_STRING_KEYS) {
    const value = collapseSpaces(raw[key]);
    if (value) filters[key] = value.toLowerCase();
  }

  for (const key of ['checkIn', 'checkOut'] as const) {
    const value = collapseSpaces(raw[key]);
    if (ISO_DATE.test(value)) filters[key] = value;
  }

  for (const key of NUMERIC_KEYS) {
    const value = toFiniteNumber(raw[key]);
    if (value !== undefined) filters[key] = value;
  }

  for (const key of LIST_KEYS) {
    const values = normalizeList(raw[key]);
    if (values.length > 0) filters[key] = values;
  }

  return { version: SAVED_SEARCH_FILTER_VERSION, filters };
}

/**
 * Encode normalised filters as URL search parameters. Lists use repeated keys
 * (`amenities=wifi&amenities=pool`) so values containing commas survive.
 */
export function encodeSavedSearchParams(normalized: VersionedSavedSearchFilters): URLSearchParams {
  const params = new URLSearchParams();
  params.set('sv', String(normalized.version));

  for (const [key, value] of Object.entries(normalized.filters)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}

/**
 * Decode URL search parameters back into normalised filters. Returns null when
 * the link was produced by an unsupported filter version, so an old or future
 * link never restores a partially understood search.
 */
export function decodeSavedSearchParams(
  params: URLSearchParams
): VersionedSavedSearchFilters | null {
  const version = Number(params.get('sv') ?? SAVED_SEARCH_FILTER_VERSION);
  if (version !== SAVED_SEARCH_FILTER_VERSION) return null;

  const raw: Record<string, unknown> = {};
  for (const key of [...LIST_KEYS]) {
    const values = params.getAll(key);
    if (values.length > 0) raw[key] = values;
  }
  for (const key of ['query', 'city', 'country', 'checkIn', 'checkOut', ...NUMERIC_KEYS]) {
    const value = params.get(key);
    if (value !== null) raw[key] = value;
  }

  return normalizeSavedSearchFilters(raw);
}

/** Build a link that reopens the search page with the saved filters applied. */
export function buildSavedSearchLink(baseUrl: string, filters: Record<string, unknown>): string {
  const url = new URL('/search', baseUrl);
  const params = encodeSavedSearchParams(normalizeSavedSearchFilters(filters));
  url.search = params.toString();
  return url.toString();
}

/**
 * Whether an alert for a saved search may be sent now given its frequency and
 * when the last alert for that search was sent.
 */
export function isAlertDue(
  frequency: DigestFrequency,
  lastSentAt: Date | null,
  now: Date
): boolean {
  if (frequency === 'immediate' || lastSentAt === null) return true;
  return now.getTime() - lastSentAt.getTime() >= FREQUENCY_WINDOW_MS[frequency];
}

/**
 * Whether `now` falls inside a quiet-hours window. Times are "HH:MM" or
 * "HH:MM:SS" (Postgres TIME) and are compared in UTC. A window whose start is
 * later than its end wraps past midnight. Missing or equal bounds mean no quiet
 * period.
 */
export function isWithinQuietHours(
  now: Date,
  start: string | null | undefined,
  end: string | null | undefined
): boolean {
  const startMin = parseClockMinutes(start);
  const endMin = parseClockMinutes(end);
  if (startMin === null || endMin === null || startMin === endMin) return false;

  const current = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (startMin < endMin) return current >= startMin && current < endMin;
  return current >= startMin || current < endMin;
}

function collapseSpaces(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function toFiniteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => collapseSpaces(v).toLowerCase())
    .filter(Boolean);
  return [...new Set(cleaned)].sort();
}

function parseClockMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
