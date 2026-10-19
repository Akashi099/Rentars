'use client';

/**
 * useCurrency — persisted display-currency selector.
 *
 * The display currency is informational only. Settlement is always in USDC.
 * Preference is stored in the `rntr_currency` cookie (ISO 4217 code).
 *
 * See: docs/I18N_CURRENCY_POLICY.md §3 Display currency
 */

import { useState, useCallback, useEffect } from 'react';

/** Cookie name for the user's display-currency preference. */
export const CURRENCY_COOKIE = 'rntr_currency';

/** Default display currency — equals USDC, no conversion needed. */
export const DEFAULT_DISPLAY_CURRENCY = 'USD';

function readCurrencyCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${CURRENCY_COOKIE}=([A-Z]{3})`),
  );
  return match ? match[1] : null;
}

function writeCurrencyCookie(currency: string): void {
  if (typeof document === 'undefined') return;
  const maxAge = 60 * 60 * 24 * 365; // 1 year
  document.cookie = `${CURRENCY_COOKIE}=${currency};max-age=${maxAge};path=/;SameSite=Lax`;
}

/**
 * Returns the active display currency and a setter that persists it to cookie.
 *
 * @example
 * const { displayCurrency, setDisplayCurrency } = useCurrency();
 */
export function useCurrency(): {
  displayCurrency: string;
  setDisplayCurrency: (currency: string) => void;
} {
  const [displayCurrency, setDisplayCurrencyState] = useState<string>(
    DEFAULT_DISPLAY_CURRENCY,
  );

  // Hydrate from cookie on mount
  useEffect(() => {
    const persisted = readCurrencyCookie();
    if (persisted) setDisplayCurrencyState(persisted);
  }, []);

  const setDisplayCurrency = useCallback((currency: string) => {
    const upper = currency.toUpperCase();
    setDisplayCurrencyState(upper);
    writeCurrencyCookie(upper);
  }, []);

  return { displayCurrency, setDisplayCurrency };
}
