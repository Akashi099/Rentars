'use client';

/**
 * PriceDisplay — renders a USDC amount with an optional local-currency estimate.
 *
 * Layout (single line):
 *   100.00 USDC  ≈ €92.00 EUR  (estimate)
 *
 * Rules:
 *  - The USDC figure is always primary and always shown.
 *  - The local-currency figure is secondary, clearly prefixed with "≈" and
 *    suffixed with "(estimate)" so users understand it is non-binding.
 *  - When the display currency is USD the estimate is omitted (1:1 with USDC).
 *  - When rates are loading or unavailable the estimate is silently omitted;
 *    never shows a broken/zero value.
 *  - When rates are stale a small warning tooltip is shown.
 */

import { useCurrency } from '@/hooks/useCurrency';
import type { DisplayCurrency } from '@/hooks/useCurrency';
import { formatMinorUnits, getCurrencyPrecision } from '@/lib/currency';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PriceDisplayProps {
  /**
   * Amount in USDC (the authoritative charge amount), expressed in USDC
   * minor units (6 decimals) as an integer string or number. Never a
   * floating-point dollar value — this keeps the primary figure exact.
   */
  amountUsdc: number | string;
  /** Optional suffix appended after the USDC figure, e.g. "/ night". */
  suffix?: string;
  /** Extra class names for the wrapper element. */
  className?: string;
  /**
   * Override the display currency for this instance (e.g. inside a picker
   * preview). When omitted the globally-stored preference is used.
   */
  currencyOverride?: DisplayCurrency;
  /** Size variant — affects text sizing. */
  size?: 'sm' | 'md' | 'lg';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sizeClasses(size: PriceDisplayProps['size']) {
  switch (size) {
    case 'sm': return { primary: 'text-sm font-semibold', estimate: 'text-xs', suffix: 'text-xs' };
    case 'lg': return { primary: 'text-xl font-bold',    estimate: 'text-sm', suffix: 'text-sm' };
    default:   return { primary: 'text-base font-bold',  estimate: 'text-xs', suffix: 'text-xs' };
  }
}

/** USDC is always denominated in 6-decimal minor units. */
const USDC_PRECISION = 6;

/** Format a rate age in milliseconds as a short human-readable string. */
function formatRateAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown age';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function PriceDisplay({
  amountUsdc,
  suffix,
  className = '',
  currencyOverride,
  size = 'md',
}: PriceDisplayProps) {
  const {
    formatEstimate,
    displayCurrency,
    ratesStale,
    ratesUnavailable,
    rateTimestamp,
    roundingMode,
    supportedCurrencies,
  } = useCurrency();

  const activeCurrency = currencyOverride ?? displayCurrency;

  // Primary USDC figure — always rendered exactly from minor units.
  const usdcDisplay = formatMinorUnits(amountUsdc, USDC_PRECISION);

  // Build the local-currency estimate string (null → omit).
  // Never show a converted value when rates are stale or unavailable.
  let estimate: string | null = null;
  if (activeCurrency !== 'USD' && !ratesStale && !ratesUnavailable) {
    estimate = formatEstimate(amountUsdc);
  }

  // Per-currency precision used for the estimate (for disclosure).
  const estimatePrecision = getCurrencyPrecision(activeCurrency);

  // Rate age for support/user disclosure.
  const rateAge =
    rateTimestamp != null ? formatRateAge(Date.now() - rateTimestamp) : null;

  const sc = sizeClasses(size);

  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 ${className}`}>
      {/* Primary: USDC amount — always shown, exact from minor units */}
      <span className={`${sc.primary} text-blue-600 dark:text-blue-400 tabular-nums`}>
        {usdcDisplay}{' '}
        USDC
      </span>

      {/* Optional per-night/per-stay suffix */}
      {suffix && (
        <span className={`${sc.suffix} font-normal text-gray-400 dark:text-gray-500`}>
          {suffix}
        </span>
      )}

      {/* Local-currency estimate */}
      {estimate && (
        <span
          className={`${sc.estimate} text-gray-500 dark:text-gray-400 whitespace-nowrap`}
          aria-label={`Approximate local currency equivalent: ${estimate}`}
        >
          {estimate}
          {' '}
          <span className="text-gray-400 dark:text-gray-500 italic">(estimate)</span>
          <abbr
            title={[
              `Converted at ${estimatePrecision}-decimal precision (${roundingMode ?? 'half-up'} rounding).`,
              rateAge ? `Rate updated ${rateAge}.` : null,
              'Charges are always in USDC.',
            ]
              .filter(Boolean)
              .join(' ')}
            className="ml-1 cursor-help text-gray-400 dark:text-gray-500 no-underline"
            aria-label={`Conversion details: ${estimatePrecision}-decimal precision, ${
              roundingMode ?? 'half-up'
            } rounding${rateAge ? `, rate updated ${rateAge}` : ''}`}
          >
            ⓘ
          </abbr>
        </span>
      )}

      {/* Stale / unavailable rate warning — shown without a converted value */}
      {activeCurrency !== 'USD' && (ratesStale || ratesUnavailable) && (
        <abbr
          title={
            ratesUnavailable
              ? 'Exchange rate unavailable — charges are always in USDC'
              : `Exchange rate may be outdated${rateAge ? ` (updated ${rateAge})` : ''} — charges are always in USDC`
          }
          className={`${sc.estimate} ml-1 cursor-help text-amber-500 dark:text-amber-400 no-underline`}
          aria-label={
            ratesUnavailable ? 'Exchange rate unavailable' : 'Exchange rate may be outdated'
          }
        >
          ⚠
        </abbr>
      )}
    </span>
  );
}

// ─── Currency Selector ────────────────────────────────────────────────────────

/**
 * Compact inline selector that lets the user pick their display currency.
 * Typically placed in a header or settings panel.
 */
export function CurrencySelector({ className = '' }: { className?: string }) {
  const { displayCurrency, setDisplayCurrency, supportedCurrencies } = useCurrency();

  if (supportedCurrencies.length === 0) return null;

  return (
    <select
      value={displayCurrency}
      onChange={(e) => setDisplayCurrency(e.target.value as DisplayCurrency)}
      aria-label="Select display currency for price estimates"
      className={`text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1
        bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300
        focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1
        ${className}`}
    >
      {supportedCurrencies.map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
    </select>
  );
}
