/**
 * Exchange Rate Routes
 *
 * GET /api/v1/exchange-rates
 *   Returns current USDC → supported display-currency rates.
 *   Publicly accessible (no auth required) — rates are non-sensitive market data.
 *
 * POST /api/v1/exchange-rates/refresh
 *   Admin-only force-refresh that bypasses the cache TTL.
 *   Useful after a provider outage or for testing.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  getExchangeRates,
  refreshExchangeRates,
  SUPPORTED_DISPLAY_CURRENCIES,
} from '@/services/exchangeRate.service.js';
import { authenticate } from '@/middleware/auth.middleware.js';
import { requireAdmin } from '@/middleware/admin.middleware.js';

const router = Router();

/**
 * Canonical decimal precision (minor-unit exponent) per display currency.
 *
 * These exponents define the number of fractional digits used when converting
 * a USDC amount into a display currency and back.  They MUST stay in sync with
 * the frontend `PriceDisplay` formatting and the backend minor-unit helpers so
 * that the UI, API, database, and contract agree on the amount and precision.
 */
const CURRENCY_DECIMAL_PRECISION: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  CNY: 2,
  INR: 2,
  BRL: 2,
  MXN: 2,
  SGD: 2,
  HKD: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  ZAR: 2,
};

/** USDC is denominated in 6-decimal integer units on-chain. */
const USDC_DECIMAL_PRECISION = 6;

/**
 * Rounding behavior applied when converting USDC → display currency.
 * Exposed so support and user-facing disclosure can describe exactly how a
 * displayed quote was derived from the submitted token amount.
 */
const ROUNDING_BEHAVIOR = {
  mode: 'half-up' as const,
  applied_to: 'display_currency' as const,
  description:
    'Converted amounts are rounded half-up to the display currency precision; ' +
    'the on-chain USDC amount is never rounded and is always an integer in 6-decimal units.',
};

/**
 * Build the per-currency precision map for all supported currencies.
 * Falls back to 2 decimals for any currency not explicitly listed.
 */
function buildPrecisionMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const currency of SUPPORTED_DISPLAY_CURRENCIES) {
    map[currency] = CURRENCY_DECIMAL_PRECISION[currency] ?? 2;
  }
  return map;
}

/**
 * GET /api/v1/exchange-rates
 *
 * Returns USDC exchange rates for all supported display currencies.
 *
 * Response shape:
 * {
 *   "base": "USDC",
 *   "rates": { "USD": 1, "EUR": 0.92, ... },
 *   "fetched_at": 1722000000000,
 *   "expires_at": 1722000300000,
 *   "stale": false,           // true when upstream was unreachable and cached data is old
 *   "source": "provider-name",// upstream rate source for support / disclosure
 *   "base_precision": 6,      // USDC minor-unit exponent
 *   "precision": { "USD": 2, "EUR": 2, "JPY": 0, ... },
 *   "rounding": { "mode": "half-up", "applied_to": "display_currency", "description": "..." },
 *   "supported_currencies": ["USD","EUR",...]
 * }
 *
 * HTTP caching:
 *   Cache-Control is set to match the server-side TTL so CDN / browser caches
 *   align with when the server will have fresh data.
 */
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const rates = await getExchangeRates();

  // Tell browsers / CDNs how long to cache the response.
  // Use a shorter window when the rates are stale so clients retry sooner.
  const maxAge = rates.stale ? 30 : Math.max(0, Math.floor((rates.expires_at - Date.now()) / 1_000));
  res.setHeader('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=60`);

  // Rate age in milliseconds, computed server-side so clients don't need to
  // trust their own clock when disclosing staleness to users.
  const rateAgeMs = Math.max(0, Date.now() - rates.fetched_at);

  res.json({
    base: rates.base,
    rates: rates.rates,
    fetched_at: rates.fetched_at,
    expires_at: rates.expires_at,
    stale: rates.stale ?? false,
    // Rate source for support and user-facing disclosure.
    source: rates.source ?? 'unknown',
    // Age of the rates in milliseconds at the time of this response.
    rate_age_ms: rateAgeMs,
    // Precision metadata so UI/API/DB/contract agree on minor units.
    base_precision: USDC_DECIMAL_PRECISION,
    precision: buildPrecisionMap(),
    rounding: ROUNDING_BEHAVIOR,
    supported_currencies: SUPPORTED_DISPLAY_CURRENCIES,
  });
});

/**
 * POST /api/v1/exchange-rates/refresh
 *
 * Force-refresh rates from upstream.  Admin only.
 */
router.post('/refresh', authenticate, requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const fresh = await refreshExchangeRates();
    res.json({
      message: 'Exchange rates refreshed successfully',
      base: fresh.base,
      fetched_at: fresh.fetched_at,
      expires_at: fresh.expires_at,
      source: fresh.source ?? 'unknown',
      stale: fresh.stale ?? false,
      base_precision: USDC_DECIMAL_PRECISION,
      precision: buildPrecisionMap(),
      rounding: ROUNDING_BEHAVIOR,
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to refresh exchange rates: ${String(err)}` });
  }
});

export default router;