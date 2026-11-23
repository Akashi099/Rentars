'use client';

import { useI18n } from '@/lib/i18n';
import { ErrorContent } from '@/components/error/ErrorContent';

interface SearchErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function SearchError({ error, reset }: SearchErrorProps) {
  const { t } = useI18n();

  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="search-error"
      title={t('errors.search.title')}
      description={t('errors.search.description')}
      retryLabel={t('errors.actions.retry')}
      homeLabel={t('errors.actions.goHome')}
    />
  );
}