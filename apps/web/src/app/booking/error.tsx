'use client';

import { useEffect, useRef } from 'react';
import { useTranslation } from '@/lib/i18n';

interface BookingErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function BookingError({ error, reset }: BookingErrorProps) {
  const { t } = useTranslation();
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-labelledby="booking-error-title"
      aria-describedby="booking-error-description"
      className="mx-auto flex max-w-lg flex-col items-center gap-4 p-6 text-center"
    >
      <h1 id="booking-error-title" className="text-xl font-semibold">
        {t('booking.error.title')}
      </h1>
      <p id="booking-error-description" className="text-sm text-gray-600">
        {t('booking.error.description')}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          ref={retryRef}
          type="button"
          onClick={reset}
          aria-label={t('booking.error.retry')}
          className="rounded bg-blue-600 px-4 py-2 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {t('booking.error.retry')}
        </button>
        <a
          href="/booking"
          aria-label={t('booking.error.back')}
          className="rounded border border-gray-300 px-4 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {t('booking.error.back')}
        </a>
      </div>
    </div>
  );
}