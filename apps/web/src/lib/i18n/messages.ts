/**
 * Lazily load the translation bundle for a given locale.
 * Keeps initial bundle small — only the active locale is imported.
 */
import type { Locale } from './config';
import type { TranslationSchema } from './locales/en';

const loaders: Record<Locale, () => Promise<{ default: TranslationSchema }>> = {
  en: () => import('./locales/en'),
  es: () => import('./locales/es'),
  fr: () => import('./locales/fr'),
  pt: () => import('./locales/pt'),
};

const cache = new Map<Locale, TranslationSchema>();

export async function getMessages(locale: Locale): Promise<TranslationSchema> {
  if (cache.has(locale)) return cache.get(locale)!;
  const mod = await loaders[locale]();
  cache.set(locale, mod.default);
  return mod.default;
}

/** Synchronously return the cached messages for a locale (falls back to en). */
export function getMessagesSync(locale: Locale): TranslationSchema {
  if (cache.has(locale)) return cache.get(locale)!;
  // Pre-load happens in I18nProvider; this fallback is for SSR safety
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./locales/en').default as TranslationSchema;
}

/**
 * Payment error taxonomy.
 *
 * Each category maps to a distinct, safe user-facing message and a set of
 * actions that are safe for the current transaction status. Messages must
 * never expose secrets (keys, signatures, raw RPC payloads) and must never
 * imply that a payment succeeded when it has not been confirmed.
 */
export type PaymentErrorCategory =
  | 'wallet_rejected'
  | 'insufficient_funds'
  | 'rpc_failure'
  | 'provider_timeout'
  | 'contract_rejected'
  | 'already_submitted'
  | 'unknown';

/** Actions a user may take in response to a payment error. */
export type PaymentErrorAction =
  | 'retry'
  | 'change_wallet'
  | 'cancel'
  | 'contact_support';

export interface PaymentErrorMessages {
  /** Short, safe title for the error category. */
  title: string;
  /** Explanation of what happened, without secrets or premature success. */
  description: string;
  /** Actions that are safe to offer for this category. */
  actions: PaymentErrorAction[];
}

export interface PaymentActionMessages {
  retry: string;
  change_wallet: string;
  cancel: string;
  contact_support: string;
}

export interface PaymentErrorI18n {
  /** Per-category messages and allowed actions. */
  categories: Record<PaymentErrorCategory, PaymentErrorMessages>;
  /** Localized labels for each action button. */
  actions: PaymentActionMessages;
  /** Generic safe fallback shown when no category matches. */
  fallback: PaymentErrorMessages;
}

/**
 * Default (English) payment error messages.
 *
 * These are intentionally conservative: no message claims a payment
 * succeeded, and none includes sensitive details. Locale bundles may
 * override these via `paymentErrors` in their translation schema.
 */
export const defaultPaymentErrorMessages: PaymentErrorI18n = {
  categories: {
    wallet_rejected: {
      title: 'Transaction rejected in wallet',
      description:
        'You declined the transaction in your wallet. No payment was sent.',
      actions: ['retry', 'change_wallet', 'cancel'],
    },
    insufficient_funds: {
      title: 'Insufficient funds',
      description:
        'Your wallet does not have enough balance to cover this payment and its network fee. No payment was sent.',
      actions: ['change_wallet', 'cancel', 'contact_support'],
    },
    rpc_failure: {
      title: 'Network error',
      description:
        'We could not reach the network to submit your payment. Your payment has not been confirmed.',
      actions: ['retry', 'cancel', 'contact_support'],
    },
    provider_timeout: {
      title: 'Request timed out',
      description:
        'The payment provider did not respond in time. Your payment status is unknown — please check before retrying to avoid a duplicate payment.',
      actions: ['retry', 'cancel', 'contact_support'],
    },
    contract_rejected: {
      title: 'Payment not accepted',
      description:
        'The payment contract rejected this transaction. No payment was completed.',
      actions: ['change_wallet', 'cancel', 'contact_support'],
    },
    already_submitted: {
      title: 'Payment already submitted',
      description:
        'A signed transaction for this payment has already been submitted. To avoid a duplicate payment, it cannot be resubmitted.',
      actions: ['cancel', 'contact_support'],
    },
    unknown: {
      title: 'Something went wrong',
      description:
        'We could not complete your payment. Your payment has not been confirmed.',
      actions: ['retry', 'cancel', 'contact_support'],
    },
  },
  actions: {
    retry: 'Try again',
    change_wallet: 'Change wallet',
    cancel: 'Cancel',
    contact_support: 'Contact support',
  },
  fallback: {
    title: 'Something went wrong',
    description:
      'We could not complete your payment. Your payment has not been confirmed.',
    actions: ['retry', 'cancel', 'contact_support'],
  },
};

/**
 * Resolve the localized payment error messages for a locale, falling back
 * to the English defaults for any missing category or action label.
 */
export function getPaymentErrorMessages(locale: Locale): PaymentErrorI18n {
  const messages = getMessagesSync(locale) as TranslationSchema & {
    paymentErrors?: Partial<PaymentErrorI18n>;
  };
  const overrides = messages.paymentErrors;
  if (!overrides) return defaultPaymentErrorMessages;

  const categories = { ...defaultPaymentErrorMessages.categories };
  if (overrides.categories) {
    for (const key of Object.keys(overrides.categories) as PaymentErrorCategory[]) {
      const value = overrides.categories[key];
      if (value) categories[key] = value;
    }
  }

  return {
    categories,
    actions: {
      ...defaultPaymentErrorMessages.actions,
      ...(overrides.actions ?? {}),
    },
    fallback: overrides.fallback ?? defaultPaymentErrorMessages.fallback,
  };
}

/**
 * Return the safe message bundle for a given error category, defaulting to
 * the generic fallback for unknown categories.
 */
export function getPaymentErrorMessage(
  locale: Locale,
  category: PaymentErrorCategory,
): PaymentErrorMessages {
  const bundle = getPaymentErrorMessages(locale);
  return bundle.categories[category] ?? bundle.fallback;
}