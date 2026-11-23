'use client';

import { ErrorContent } from '@/components/error/ErrorContent';

interface BookingErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function BookingError({ error, reset }: BookingErrorProps) {
  return (
    <ErrorContent
      error={error}
      reset={reset}
      context="booking-error"
      title="We couldn't load your bookings"
      description="Something went wrong while loading your booking history. Your bookings are safe — please try again."
      retryLabel="Retry loading bookings"
      announce
    />
  );
}