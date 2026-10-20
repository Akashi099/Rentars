'use client';

import { useMemo } from 'react';
import { ErrorContent } from '@/components/error/ErrorContent';
import {
  classifyPaymentError,
  getPaymentErrorPresentation,
  type PaymentErrorPresentation,
} from '@/lib/payments/paymentErrorTaxonomy';

interface BookingErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function BookingError({ error, reset }: BookingErrorProps) {
  const presentation: PaymentErrorPresentation = useMemo(() => {
    const category = classifyPaymentError(error);
    return getPaymentErrorPresentation(category);
  }, [error]);

  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="booking-error"
      title={presentation.title}
      message={presentation.message}
      actions={presentation.actions}
      severity={presentation.severity}
      supportHint={presentation.supportHint}
      retryable={presentation.retryable}
    />
  );
}