/**
 * i18n public API — export everything consumers need.
 */
export { type Locale, DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_LABELS, LOCALE_COOKIE, isValidLocale } from './config';
export { useLocale } from './useLocale';
export { useTranslations } from './useTranslations';
export {
  formatDate,
  formatCurrency,
  formatNumber,
  formatSettlementAmount,
  formatDisplayConversion,
  formatDateTimeWithZone,
  formatNightCount,
  type ConversionResult,
} from './formatting';
export { getMessages } from './messages';
export { useCurrency, CURRENCY_COOKIE, DEFAULT_DISPLAY_CURRENCY } from './useCurrency';
