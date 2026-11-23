'use client';

import { useEffect, useId, useRef } from 'react';
import { ErrorContent } from '@/components/error/ErrorContent';
import { useI18n } from '@/lib/i18n/I18nProvider';

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: DashboardErrorProps) {
  const { t } = useI18n();

  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="dashboard-error"
      title={t('errors.dashboard.title')}
      description={t('errors.dashboard.description')}
      retryLabel={t('errors.actions.retry')}
      homeLabel={t('errors.actions.backToHome')}
      retryAriaLabel={t('errors.actions.retryAriaLabel')}
    />
  );
}