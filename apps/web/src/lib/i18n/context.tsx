'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { DEFAULT_LOCALE, LOCALE_COOKIE, isValidLocale, type Locale } from './config';
import { getMessages } from './messages';
import type { TranslationSchema } from './locales/en';
import en from './locales/en';

/** BCP 47 tags used for Intl date/number/currency formatting per supported locale. */
export const INTL_LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  pt: 'pt-PT',
};

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface I18nFormatters {
  /** Format a date using the active locale's conventions. */
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  /** Format a number using the active locale's conventions. */
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** Format a monetary amount using the active locale's currency conventions. */
  formatCurrency: (value: number, currency: string, options?: Intl.NumberFormatOptions) => string;
  /** Resolve the CLDR plural category for a count in the active locale. */
  getPluralCategory: (count: number) => PluralCategory;
  /** Pick the plural form for a count from a set of localized variants. */
  plural: (count: number, forms: Partial<Record<PluralCategory, string>>) => string;
}

interface I18nContextValue extends I18nFormatters {
  locale: Locale;
  messages: TranslationSchema;
  setLocale: (locale: Locale) => void;
}

function createFormatters(locale: Locale): I18nFormatters {
  const tag = INTL_LOCALE_TAGS[locale] ?? INTL_LOCALE_TAGS[DEFAULT_LOCALE];
  let pluralRules: Intl.PluralRules | null = null;
  try {
    pluralRules = new Intl.PluralRules(tag);
  } catch {
    pluralRules = null;
  }

  const getPluralCategory = (count: number): PluralCategory => {
    if (!pluralRules) return count === 1 ? 'one' : 'other';
    return pluralRules.select(count) as PluralCategory;
  };

  return {
    formatDate: (value, options) => {
      const date = value instanceof Date ? value : new Date(value);
      try {
        return new Intl.DateTimeFormat(tag, options).format(date);
      } catch {
        return date.toISOString();
      }
    },
    formatNumber: (value, options) => {
      try {
        return new Intl.NumberFormat(tag, options).format(value);
      } catch {
        return String(value);
      }
    },
    formatCurrency: (value, currency, options) => {
      try {
        return new Intl.NumberFormat(tag, { style: 'currency', currency, ...options }).format(value);
      } catch {
        return `${value} ${currency}`;
      }
    },
    getPluralCategory,
    plural: (count, forms) => {
      const category = getPluralCategory(count);
      return forms[category] ?? forms.other ?? '';
    },
  };
}

const defaultFormatters = createFormatters(DEFAULT_LOCALE);

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  messages: en,
  setLocale: () => undefined,
  ...defaultFormatters,
});
======

export function useI18nContext(): I18nContextValue {
  return useContext(I18nContext);
}

function readLocaleCookie(): Locale | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`));
  return match && isValidLocale(match[1]) ? (match[1] as Locale) : null;
}

function writeLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return;
  // 1-year expiry, SameSite=Lax for cross-page navigation
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${LOCALE_COOKIE}=${locale};max-age=${maxAge};path=/;SameSite=Lax`;
}

function detectBrowserLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  const lang = navigator.language?.split('-')[0];
  return isValidLocale(lang) ? (lang as Locale) : DEFAULT_LOCALE;
}

interface I18nProviderProps {
  children: ReactNode;
  /** Initial locale — pass from a server-read cookie on first render to avoid flicker. */
  initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);
  const [messages, setMessages] = useState<TranslationSchema>(en);

  // On mount: resolve locale priority: cookie > browser > default
  // Only run browser/cookie detection if no initialLocale was explicitly provided
  useEffect(() => {
    if (initialLocale) {
      // initialLocale was server-provided; just ensure the messages are loaded
      getMessages(initialLocale).then(setMessages);
      return;
    }
    const cookie = readLocaleCookie();
    const resolved = cookie ?? detectBrowserLocale();
    if (resolved !== locale) {
      setLocaleState(resolved);
    }
    getMessages(resolved).then(setMessages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    writeLocaleCookie(next);
    getMessages(next).then(setMessages);
  }, []);

  const formatters = useMemo(() => createFormatters(locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, messages, setLocale, ...formatters }),
    [locale, messages, setLocale, formatters],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
