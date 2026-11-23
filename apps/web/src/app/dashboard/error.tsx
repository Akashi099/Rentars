'use client';

import { useEffect, useId, useRef } from 'react';
import { ErrorContent } from '@/components/error/ErrorContent';

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  const headingId = useId();
  const liveRegionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = `Error loading dashboard: ${error.message}`;
    }
  }, [error]);

  return (
    <section aria-labelledby={headingId} role="region">
      <div
        ref={liveRegionRef}
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      />
      <ErrorContent
        error={error}
        reset={reset}
        context="dashboard-error"
        headingId={headingId}
        retryLabel="Retry loading dashboard"
      />
    </section>
  );
}