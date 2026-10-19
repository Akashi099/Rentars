'use client';

import { ErrorContent } from '@/components/error/ErrorContent';

interface PropertyErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function PropertyError({ error, reset }: PropertyErrorProps) {
  return <ErrorContent error={error} reset={reset} context="property-error" />;
}
