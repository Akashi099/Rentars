/** Shared types for search — used by usePropertySearch and FilterSidebar. */

export interface PriceHistogramBucket {
  /** Lower bound of this bucket (inclusive). */
  min: number;
  /** Upper bound of this bucket (exclusive, except the last bucket). */
  max: number;
  /** Number of listings in this bucket. */
  count: number;
}

export interface PriceHistogramResult {
  buckets: PriceHistogramBucket[];
  /** Lowest price across all listings in current context (price filter excluded). */
  global_min: number;
  /** Highest price across all listings in current context (price filter excluded). */
  global_max: number;
}

/**
 * A single search result rendered both on the map (as a pin) and in the
 * accessible list fallback. The same `id` is used to synchronize selection
 * state between the map pin and its equivalent list item.
 */
export interface SearchResultItem {
  /** Stable unique identifier for the listing; shared by map pin and list item. */
  id: string;
  /** Human-readable title used in labels and list entries. */
  title: string;
  /** Formatted price string (e.g. "$1,250,000") for display and announcements. */
  price: string;
  /** Optional formatted address for display and announcements. */
  address?: string;
  /** Optional number of bedrooms, included in essential details. */
  bedrooms?: number;
  /** Optional number of bathrooms, included in essential details. */
  bathrooms?: number;
  /** Optional formatted living area (e.g. "1,200 sq ft"). */
  area?: string;
  /** Latitude of the listing for map placement. */
  latitude: number;
  /** Longitude of the listing for map placement. */
  longitude: number;
  /** Optional URL to the property detail view. */
  href?: string;
}

/**
 * Selection state shared between the map pins and the accessible list
 * fallback so that both views stay in sync.
 */
export interface SearchResultSelection {
  /** Id of the currently selected result, or null when nothing is selected. */
  selectedId: string | null;
  /** Id of the result whose detail view is currently open, or null. */
  detailId: string | null;
}

/**
 * Metadata describing the accessible list fallback for a set of search
 * results. Guarantees every visible map result has an equivalent list entry.
 */
export interface SearchResultListFallback {
  /** Ordered results rendered in the list; mirrors the visible map results. */
  items: SearchResultItem[];
  /** Current selection state, synchronized with the map. */
  selection: SearchResultSelection;
  /** Whether the map interaction is available; when false the list is the primary view. */
  mapAvailable: boolean;
}
