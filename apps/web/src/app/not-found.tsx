'use client';

import Link from 'next/link';
import { House, Search, ArrowLeft } from 'lucide-react';
import { useTranslation } from '@/lib/i18n/useTranslation';

/**
 * App Router not-found.tsx — rendered when notFound() is called or a route
 * doesn't match.  This is a Client Component so it can render localized text
 * via the i18n context and keep the search box and navigation links keyboard
 * accessible with proper labels.
 */
export default function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <main
      role="main"
      aria-labelledby="not-found-title"
      className="flex min-h-screen flex-col items-center justify-center px-4 py-16 text-center"
    >
      <div className="mx-auto w-full max-w-md">
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
          {t('errors.notFound.code')}
        </p>
        <h1
          id="not-found-title"
          className="mt-2 text-3xl font-bold tracking-tight text-gray-900"
        >
          {t('errors.notFound.title')}
        </h1>
        <p className="mt-4 text-base text-gray-600">
          {t('errors.notFound.description')}
        </p>

        <form
          role="search"
          className="mt-8"
          onSubmit={(event) => event.preventDefault()}
        >
          <label htmlFor="not-found-search" className="sr-only">
            {t('errors.notFound.searchLabel')}
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
            />
            <input
              id="not-found-search"
              type="search"
              name="q"
              placeholder={t('errors.notFound.searchPlaceholder')}
              aria-describedby="not-found-search-hint"
              className="w-full rounded-md border border-gray-300 py-2 pl-10 pr-3 text-left text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <p id="not-found-search-hint" className="sr-only">
            {t('errors.notFound.searchHint')}
          </p>
        </form>

        <nav
          aria-label={t('errors.notFound.navigationLabel')}
          className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            <House aria-hidden="true" className="h-4 w-4" />
            {t('errors.notFound.backHome')}
          </Link>
          <Link
            href="/listings"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            {t('errors.notFound.browseListings')}
          </Link>
        </nav>
      </div>
    </main>
  );
}