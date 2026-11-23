'use client';

import { useEffect, useRef } from 'react';
import { ErrorContent } from '@/components/error/ErrorContent';

interface SearchErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SearchError({ error, reset }: SearchErrorProps) {
  const announcementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Announce the error state accessibly without stealing focus.
    if (announcementRef.current) {
      announcementRef.current.textContent = `Search failed to load: ${
        error.message || 'An unexpected error occurred'
      }. You can retry.`;
    }
  }, [error]);

  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      <div ref={announcementRef} className="sr-only" aria-live="assertive" />
      <ErrorContent
        error={error}
        reset={reset}
        context="search-error"
        retryLabel="Retry search"
        description="We couldn't load your search results. Your filters have been preserved — retry to try again."
      />
    </div>
  );
}