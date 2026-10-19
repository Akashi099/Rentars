'use client';

/**
 * ErrorContent — the testable, reusable error boundary UI with safe recovery.
 *
 * Handles:
 * - Rendering errors (unexpected crashes)
 * - Authorization errors (401/403 — redirect to sign-in without disclosing resource existence)
 * - Missing resources (404 — handled separately in not-found.tsx)
 * - API failures with retry capability
 * 
 * Includes redacted correlation ID for support (digest) and safe navigation that preserves context.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { House, Search, RotateCcw, AlertTriangle, LogIn } from 'lucide-react';
import { logClientError } from '@/lib/errorLogger';

export interface ErrorContentProps {
  /** The thrown error. May have a Next.js `digest` for reference. */
  error: Error & { digest?: string; statusCode?: number };
  /** Callback that re-renders the failed segment — provided by Next.js error.tsx. */
  reset: () => void;
  /** Override the context label sent to the logger. */
  context?: string;
}

export function ErrorContent({ error, reset, context = 'error-boundary' }: ErrorContentProps) {
  const router = useRouter();
  const [retryCount, setRetryCount] = useState(0);
  const MAX_RETRIES = 3;

  // Determine error type
  const isAuthError = error.message?.toLowerCase().includes('unauthorized') ||
    error.message?.toLowerCase().includes('authentication') ||
    (error as any).statusCode === 401 ||
    (error as any).statusCode === 403;

  useEffect(() => {
    logClientError(error, context, error.digest);
  }, [error, context]);

  const handleRetry = () => {
    if (retryCount < MAX_RETRIES) {
      setRetryCount(prev => prev + 1);
      reset();
    }
  };

  const handleSignIn = () => {
    // Preserve current path for redirect after sign-in
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    router.push(`/login?returnUrl=${returnUrl}`);
  };

  // Authorization error: don't disclose resource existence, offer sign-in
  if (isAuthError) {
    return (
      <main
        className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-6 py-16"
        aria-labelledby="error-heading"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex items-center gap-2 mb-10" aria-hidden="true">
          <House size={32} className="text-blue-600" />
          <span className="text-2xl font-bold text-gray-900 dark:text-white">Rentars</span>
        </div>

        <div
          className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-6"
          aria-hidden="true"
        >
          <LogIn size={32} className="text-amber-600 dark:text-amber-400" />
        </div>

        <h1
          id="error-heading"
          className="text-3xl font-bold text-gray-900 dark:text-white text-center"
        >
          Sign in required
        </h1>

        <p className="mt-3 text-base text-gray-500 dark:text-gray-400 text-center max-w-md">
          You need to be signed in to access this page. Sign in to continue, or browse public listings.
        </p>

        {error.digest && (
          <p className="mt-3 text-xs text-gray-400 dark:text-gray-600 font-mono" data-testid="error-digest">
            Reference: {error.digest}
          </p>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={handleSignIn}
            data-testid="sign-in-button"
            className="
              inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
              bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white
              text-sm font-medium transition
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            "
          >
            <LogIn size={16} aria-hidden="true" />
            Sign in
          </button>

          <Link
            href="/"
            data-testid="go-home-link"
            className="
              inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
              bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
              text-sm font-medium text-gray-700 dark:text-gray-200
              hover:bg-gray-50 dark:hover:bg-gray-700 transition
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            "
          >
            <House size={16} aria-hidden="true" />
            Go home
          </Link>

          <Link
            href="/search"
            data-testid="browse-link"
            className="
              inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
              text-sm font-medium text-gray-500 dark:text-gray-400
              hover:text-gray-700 dark:hover:text-gray-200 transition
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
            "
          >
            <Search size={16} aria-hidden="true" />
            Browse properties
          </Link>
        </div>
      </main>
    );
  }

  // Generic error: provide retry with limit
  return (
    <main
      className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col items-center justify-center px-6 py-16"
      aria-labelledby="error-heading"
      role="alert"
      aria-live="assertive"
    >
      {/* Branded logo mark */}
      <div className="flex items-center gap-2 mb-10" aria-hidden="true">
        <House size={32} className="text-blue-600" />
        <span className="text-2xl font-bold text-gray-900 dark:text-white">Rentars</span>
      </div>

      {/* Warning icon */}
      <div
        className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-6"
        aria-hidden="true"
      >
        <AlertTriangle size={32} className="text-red-600 dark:text-red-400" />
      </div>

      <h1
        id="error-heading"
        className="text-3xl font-bold text-gray-900 dark:text-white text-center"
      >
        Something went wrong
      </h1>

      <p className="mt-3 text-base text-gray-500 dark:text-gray-400 text-center max-w-md">
        We&apos;ve been notified and are working on a fix. Please try again, or head back
        home while we sort things out.
      </p>

      {/* Digest — support reference, never a full stack trace */}
      {error.digest && (
        <p className="mt-3 text-xs text-gray-400 dark:text-gray-600 font-mono" data-testid="error-digest">
          Error code: {error.digest}
        </p>
      )}

      {/* Recovery actions */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {retryCount < MAX_RETRIES && (
          <button
            onClick={handleRetry}
            data-testid="retry-button"
            className="
              inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
              bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white
              text-sm font-medium transition
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            <RotateCcw size={16} aria-hidden="true" />
            Try again {retryCount > 0 && `(${MAX_RETRIES - retryCount} attempts left)`}
          </button>
        )}

        {retryCount >= MAX_RETRIES && (
          <p className="text-sm text-gray-500 dark:text-gray-400 px-5 py-2.5">
            Maximum retry attempts reached
          </p>
        )}

        <Link
          href="/"
          data-testid="go-home-link"
          className="
            inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
            bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
            text-sm font-medium text-gray-700 dark:text-gray-200
            hover:bg-gray-50 dark:hover:bg-gray-700 transition
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
          "
        >
          <House size={16} aria-hidden="true" />
          Go home
        </Link>

        <Link
          href="/search"
          data-testid="browse-link"
          className="
            inline-flex items-center gap-2 px-5 py-2.5 rounded-lg
            text-sm font-medium text-gray-500 dark:text-gray-400
            hover:text-gray-700 dark:hover:text-gray-200 transition
            focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
          "
        >
          <Search size={16} aria-hidden="true" />
          Browse properties
        </Link>
      </div>
    </main>
  );
}
