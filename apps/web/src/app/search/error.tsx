'use client';

import { ErrorContent } from '@/components/error/ErrorContent';

interface SearchErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SearchError({ error, reset }: SearchErrorProps) {
  return <ErrorContent error={error} reset={reset} context="search-error" />;
}
