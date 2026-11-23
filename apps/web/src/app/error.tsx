'use client';

import { ErrorContent } from '@/components/error/ErrorContent';
import { useI18n } from '@/lib/i18n/I18nProvider';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  const { t } = useI18n();

  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="global-error-boundary"
      title={t('errors.global.title')}
      description={t('errors.global.description')}
      retryLabel={t('errors.global.retry')}
      retryAriaLabel={t('errors.global.retryAriaLabel')}
      errorDetailsLabel={t('errors.global.detailsLabel')}
      errorIdLabel={t('errors.global.errorIdLabel')}
    />
  );
}