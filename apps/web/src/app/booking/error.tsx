'use client';

import { ErrorContent } from '@/components/error/ErrorContent';

interface BookingErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function BookingError({ error, reset }: BookingErrorProps) {
  return <ErrorContent error={error} reset={reset} context="booking-error" />;
}
