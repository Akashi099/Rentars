'use client';

/**
 * global-error.tsx — catches errors in the root layout itself.
 *
 * This is a last-resort boundary. It must render its own <html> and <body>
 * because the root layout may be broken. Keep it as lean as possible.
 */

import { useEffect, useState } from 'react';
import { logClientError } from '@/lib/errorLogger';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

type SupportedLocale = 'en' | 'es' | 'fr' | 'pt';

const SUPPORTED_LOCALES: readonly SupportedLocale[] = ['en', 'es', 'fr', 'pt'];

const DEFAULT_LOCALE: SupportedLocale = 'en';

const STRINGS: Record<
  SupportedLocale,
  {
    title: string;
    description: string;
    errorCode: string;
    tryAgain: string;
    goHome: string;
  }
> = {
  en: {
    title: 'Something went wrong',
    description: 'An unexpected error occurred. Please try again or return to the home page.',
    errorCode: 'Error code',
    tryAgain: 'Try again',
    goHome: 'Go home',
  },
  es: {
    title: 'Algo salió mal',
    description: 'Se produjo un error inesperado. Inténtalo de nuevo o vuelve a la página de inicio.',
    errorCode: 'Código de error',
    tryAgain: 'Intentar de nuevo',
    goHome: 'Ir al inicio',
  },
  fr: {
    title: 'Une erreur est survenue',
    description: "Une erreur inattendue s'est produite. Veuillez réessayer ou revenir à la page d'accueil.",
    errorCode: "Code d'erreur",
    tryAgain: 'Réessayer',
    goHome: "Retour à l'accueil",
  },
  pt: {
    title: 'Algo deu errado',
    description: 'Ocorreu um erro inesperado. Tente novamente ou volte para a página inicial.',
    errorCode: 'Código do erro',
    tryAgain: 'Tentar novamente',
    goHome: 'Ir para o início',
  },
};

function normalizeLocale(value: string | null | undefined): SupportedLocale | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as SupportedLocale) : null;
}

function readLocaleCookie(): SupportedLocale | null {
  if (typeof document === 'undefined') return null;
  try {
    const match = document.cookie.match(/(?:^|;\s*)(?:NEXT_LOCALE|locale)=([^;]+)/);
    return match ? normalizeLocale(decodeURIComponent(match[1])) : null;
  } catch {
    return null;
  }
}

function resolveLocale(): SupportedLocale {
  const fromCookie = readLocaleCookie();
  if (fromCookie) return fromCookie;
  if (typeof navigator !== 'undefined') {
    const fromNavigator = normalizeLocale(navigator.language);
    if (fromNavigator) return fromNavigator;
  }
  return DEFAULT_LOCALE;
}

const focusVisibleStyle = `
  .global-error-action:focus-visible {
    outline: 3px solid #1d4ed8;
    outline-offset: 2px;
  }
`;

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const [locale, setLocale] = useState<SupportedLocale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocale(resolveLocale());
  }, []);

  useEffect(() => {
    logClientError(error, 'global-root-error-boundary', error.digest);
  }, [error]);

  const t = STRINGS[locale];

  return (
    <html lang={locale}>
      <head>
        <style>{focusVisibleStyle}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          backgroundColor: '#f9fafb',
          color: '#111827',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2563eb"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ marginBottom: '1.5rem' }}
        >
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>

        <h1 style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0 0 0.75rem' }}>
          {t.title}
        </h1>
        <p style={{ color: '#6b7280', maxWidth: '28rem', margin: '0 auto 2rem' }}>
          {t.description}
        </p>

        {error.digest && (
          <p style={{ fontSize: '0.75rem', color: '#9ca3af', fontFamily: 'monospace', marginBottom: '1.5rem' }}>
            {t.errorCode}: {error.digest}
          </p>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            type="button"
            className="global-error-action"
            onClick={reset}
            style={{
              padding: '0.625rem 1.25rem',
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '0.5rem',
              fontWeight: 500,
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            {t.tryAgain}
          </button>
          <a
            href="/"
            className="global-error-action"
            style={{
              padding: '0.625rem 1.25rem',
              background: '#fff',
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: '0.5rem',
              fontWeight: 500,
              cursor: 'pointer',
              fontSize: '0.875rem',
              textDecoration: 'none',
            }}
          >
            {t.goHome}
          </a>
        </div>
      </body>
    </html>
  );
}
