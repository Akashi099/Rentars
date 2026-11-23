'use client';

import { ErrorContent } from '@/components/error/ErrorContent';
import { AsyncStateAnnouncer } from '@/components/state/AsyncStateAnnouncer';

interface PropertyErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function PropertyError({ error, reset }: PropertyErrorProps) {
  return (
    <>
      <AsyncStateAnnouncer
        status="error"
        message="There was a problem loading this property. You can try again."
      />
      <ErrorContent
        error={error}
        reset={reset}
        context="property-error"
        retryLabel="Try again"
      />
    </>
  );
}