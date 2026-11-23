'use client';

import { useI18n } from '@/lib/i18n';
import { ErrorContent } from '@/components/error/ErrorContent';
import { AsyncStateAnnouncer } from '@/components/state/AsyncStateAnnouncer';

interface PropertyErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function PropertyError({ error, reset }: PropertyErrorProps) {
  const { t } = useI18n();

  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="property-error"
      title={t('errors.property.title')}
      description={t('errors.property.description')}
      retryLabel={t('errors.retry')}
      retryAriaLabel={t('errors.retryAriaLabel')}
    />
  );
}