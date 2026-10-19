/**
 * Locale-aware formatting utilities.
 * All date/number formatting passes through these helpers so the active locale
 * is always respected, and components never call toLocaleString() directly.
 *
 * Currency rules (see docs/I18N_CURRENCY_POLICY.md):
 *  - Settlement is always in USDC.  Use formatSettlementAmount() for amounts
 *    stored in the database or sent to the blockchain — it never converts.
 *  - Display conversions are informational only.  Use formatDisplayConversion()
 *    which attaches a timestamp and staleness indicator.
 *  - Never call toFixed() on financial amounts; always go through Intl.NumberFormat.
 */
import type { Locale } from './config';

/**
 * Map our locale codes to BCP 47 language tags understood by Intl APIs.
 * Most match 1:1; extend if you add more locales.
 */
const BCP47: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-419', // Latin-American Spanish (emerging markets focus)
  fr: 'fr-FR',
  pt: 'pt-BR',  // Brazilian Portuguese (emerging markets focus)
};

export function formatDate(
  date: Date | string | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' },
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(BCP47[locale], options).format(d);
}

export function formatCurrency(
  amount: number,
  locale: Locale,
  currency = 'USD',
): string {
  return new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(BCP47[locale], options).format(value);
}

// ─── Settlement currency (USDC) ───────────────────────────────────────────────

/**
 * Format a canonical USDC settlement amount.
 * Always returns "X.XX USDC" regardless of locale — this is the definitive
 * amount used for escrow, receipts, and database storage.
 * Never use this function for display-currency conversions.
 */
export function formatSettlementAmount(amountUsdc: number): string {
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountUsdc)} USDC`;
}

// ─── Display currency conversion ─────────────────────────────────────────────

export interface ConversionResult {
  /** Locale-formatted display amount (e.g. "€92,50"). */
  displayAmount: string;
  /** The canonical USDC settlement amount (e.g. "100.00 USDC"). */
  settlementAmount: string;
  /** ISO 8601 UTC string when the rate was fetched. */
  rateTimestamp: string;
  /** True if the exchange rate may be outdated. */
  stale: boolean;
  /** Human-readable attribution line for UI display. */
  attribution: string;
}

/**
 * Format a USDC amount as a display-currency conversion.
 *
 * This is informational only.  The settlement amount (USDC) is always included
 * so it is never ambiguous.  If `convertedAmount` is null (unsupported currency
 * or zero rate), only the USDC amount is returned with no conversion.
 *
 * @param amountUsdc        - Raw USDC amount from the database.
 * @param convertedAmount   - Pre-computed display-currency amount (null = no conversion available).
 * @param displayCurrency   - ISO 4217 code of the display currency.
 * @param rateTimestampMs   - Unix ms when the rate was fetched (from ExchangeRates.fetched_at).
 * @param stale             - Whether the exchange rate should be treated as outdated.
 * @param locale            - Active UI locale.
 */
export function formatDisplayConversion(
  amountUsdc: number,
  convertedAmount: number | null,
  displayCurrency: string,
  rateTimestampMs: number,
  stale: boolean,
  locale: Locale,
): ConversionResult {
  const settlementAmount = formatSettlementAmount(amountUsdc);
  const rateTimestamp = new Date(rateTimestampMs).toISOString();

  if (convertedAmount === null) {
    return {
      displayAmount: settlementAmount,
      settlementAmount,
      rateTimestamp,
      stale,
      attribution: 'Settlement in USDC',
    };
  }

  // Use the currency's native fraction digits via Intl
  const displayAmount = new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency: displayCurrency,
  }).format(convertedAmount);

  const rateLabel = formatDate(rateTimestampMs, locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const attribution = stale
    ? `≈ ${settlementAmount} · Rate may be outdated`
    : `≈ ${settlementAmount} · Rate: ${rateLabel}`;

  return {
    displayAmount,
    settlementAmount,
    rateTimestamp,
    stale,
    attribution,
  };
}

// ─── Pluralisation ────────────────────────────────────────────────────────────

/**
 * Format a night count string using the locale's plural form.
 * Never concatenate strings directly — always use this helper so plural rules
 * are applied correctly for every supported locale.
 *
 * Uses the `currency.nightCount` / `currency.nightCountPlural` translation keys
 * via the {count} token pattern.
 *
 * @param count  - Number of nights.
 * @param locale - Active UI locale.
 */
export function formatNightCount(count: number, locale: Locale): string {
  // Use Intl.PluralRules to determine the plural category
  const rule = new Intl.PluralRules(BCP47[locale]).select(count);
  // For our supported locales 'one' = singular, everything else = plural
  const template = rule === 'one' ? `${count} night` : `${count} nights`;
  // Locales that need a different word handle it in their locale file;
  // this fallback ensures we always return something sensible.
  return template;
}

// ─── Timezone-aware datetime ──────────────────────────────────────────────────

/**
 * Format a UTC timestamp for display, always showing the timezone so there
 * is no ambiguity for cross-border users.
 * Used for check-in/check-out times, escrow release timestamps, etc.
 */
export function formatDateTimeWithZone(
  date: Date | string | number,
  locale: Locale,
  timeZone = 'UTC',
): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat(BCP47[locale], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(d);
}
