'use client';

import { useEffect, useRef, useState } from 'react';
import { Calendar, Users, AlertCircle } from 'lucide-react';
import { useTranslations } from '@/lib/i18n/useTranslations';
import { useLocale } from '@/lib/i18n/useLocale';
import { formatCurrency } from '@/lib/i18n/formatting';
import { getErrorMessage, isApiError } from '@/lib/errors/errorCodes';
import { PaymentErrorDisplay } from '@/components/payment/PaymentErrorDisplay';
import { useCurrency } from '@/hooks/useCurrency';
import { useFormErrorFocus } from '@/hooks/useFormErrorFocus';
import { buildDescribedBy } from '@/components/ui/form-field';

interface BookingFormProps {
  propertyId: string;
  pricePerNight: number;
  /** Maximum number of guests allowed by the property. Omit to leave uncapped. */
  maxGuests?: number;
  /** Minimum number of nights required for a booking. */
  minStay?: number;
  /** Maximum number of nights allowed for a booking. */
  maxStay?: number;
  onSubmit: (data: { checkIn: Date; checkOut: Date; guestCount: number; totalPrice: number }) => void;
  isLoading?: boolean;
  /**
   * A payment-flow error to display after the booking form is submitted and the
   * wallet / payment step fails. When provided, PaymentErrorDisplay is rendered
   * below the submit button with the correct classified messaging and actions.
   */
  paymentError?: unknown;
  /** Latest server-side payment status — used by PaymentErrorDisplay to prevent
   *  retry when the XDR is already submitted. */
  currentPaymentStatus?: string;
  /** Called when the user retries the payment from the error display. */
  onRetryPayment?: () => void;
}

interface PriceQuote {
  base_nightly_rate: number;
  nights: number;
  subtotal: number;
  dynamic_adjustments: number;
  platform_fee_pct: number;
  platform_fee: number;
  total: number;
  breakdown: Array<{ date: string; price: number; is_available: boolean; reason?: string }>;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function BookingForm({
  propertyId,
  maxGuests,
  minStay,
  maxStay,
  onSubmit,
  isLoading = false,
  paymentError,
  currentPaymentStatus,
  onRetryPayment,
}: BookingFormProps) {
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [guestCount, setGuestCount] = useState(1);
  const [dateError, setDateError] = useState('');
  const [guestError, setGuestError] = useState('');
  const [pricing, setPricing] = useState<PriceQuote | null>(null);
  const [availabilityError, setAvailabilityError] = useState('');
  const errorSummaryRef = useRef<HTMLDivElement | null>(null);

  const t = useTranslations('booking');
  const { locale } = useLocale();
  const { formatEstimate, displayCurrency, ratesStale } = useCurrency();
  const { focusFirstError } = useFormErrorFocus();
  const today = new Date().toISOString().split('T')[0];

  useEffect(() => {
    if (!checkIn || !checkOut) return;

    const controller = new AbortController();

    const fetchPricing = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/v1/properties/${propertyId}/quote?start=${checkIn}&end=${checkOut}`,
          { signal: controller.signal },
        );

        if (res.ok) {
          setPricing(await res.json());
          setDateError('');
        } else {
          const body = await res.json();
          setDateError(
            isApiError(body)
              ? getErrorMessage(body.error.code, body.error.message)
              : t('cantCalculatePrice'),
          );
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setDateError('Failed to fetch pricing');
      }
    };

    fetchPricing();

    return () => {
      controller.abort();
    };
  }, [checkIn, checkOut, propertyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGuestChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    setGuestCount(isNaN(val) ? 0 : val);

    if (isNaN(val) || val < 1) {
      setGuestError('At least 1 guest is required');
    } else if (maxGuests !== undefined && val > maxGuests) {
      setGuestError(`Maximum ${maxGuests} guest${maxGuests === 1 ? '' : 's'} allowed`);
    } else {
      setGuestError('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDateError('');
    setGuestError('');
    setAvailabilityError('');

    // Validation — collect errors before focusing
    let foundDateError = '';
    let foundGuestError = '';

    if (!checkIn || !checkOut) {
      foundDateError = t('invalidDates');
    } else if (new Date(checkIn) >= new Date(checkOut)) {
      foundDateError = t('checkoutAfterCheckin');
    } else {
      const stayNights = Math.ceil(
        (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000,
      );
      if (minStay !== undefined && stayNights < minStay) {
        foundDateError = `Minimum stay is ${minStay} night${minStay === 1 ? '' : 's'}`;
      } else if (maxStay !== undefined && stayNights > maxStay) {
        foundDateError = `Maximum stay is ${maxStay} night${maxStay === 1 ? '' : 's'}`;
      }
    }

    if (guestCount < 1) {
      foundGuestError = 'At least 1 guest is required';
    } else if (maxGuests !== undefined && guestCount > maxGuests) {
      foundGuestError = `Maximum ${maxGuests} guest${maxGuests === 1 ? '' : 's'} allowed`;
    }

    if (foundDateError || foundGuestError) {
      if (foundDateError) setDateError(foundDateError);
      if (foundGuestError) setGuestError(foundGuestError);
      // Focus the error summary which has role="alert" — screen readers announce it
      focusFirstError('booking-error-summary');
      return;
    }

    // Check availability
    try {
      const res = await fetch(
        `${API_URL}/api/v1/calendar/${propertyId}/check?checkIn=${checkIn}&checkOut=${checkOut}`,
      );

      if (res.ok) {
        const data = await res.json();
        if (!data.available) {
          setAvailabilityError(
            isApiError(data)
              ? getErrorMessage(data.error.code, data.error.message)
              : (data.reason || t('unavailableDates')),
          );
          focusFirstError('booking-error-summary');
          return;
        }
      }
    } catch {
      setDateError('Failed to check availability');
      focusFirstError('booking-error-summary');
      return;
    }

    if (!pricing) {
      setDateError(t('cantCalculatePrice'));
      focusFirstError('booking-error-summary');
      return;
    }

    const hasBlocked = pricing.breakdown.some((d) => !d.is_available);
    if (hasBlocked) {
      setDateError(t('hasBlockedDates'));
      focusFirstError('booking-error-summary');
      return;
    }

    onSubmit({
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guestCount,
      totalPrice: pricing.total,
    });
  };

  const nights =
    checkIn && checkOut
      ? Math.ceil(
          (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000,
        )
      : 0;

  const stayViolation =
    nights > 0 &&
    ((minStay !== undefined && nights < minStay) || (maxStay !== undefined && nights > maxStay));

  const hasDateError = !!(dateError || availabilityError);
  const isOverCapacity = maxGuests !== undefined && guestCount > maxGuests;

  // Both date inputs share the date error — both should be aria-invalid when
  // the error relates to the combination of the two fields.
  const dateDescribedBy = buildDescribedBy('check-in', hasDateError, false);

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6 space-y-4"
      noValidate
      aria-label={t('bookNow')}
    >
      {/* ── Error summary ──────────────────────────────────────────────── */}
      {(hasDateError || !!guestError) && (
        <div
          id="booking-error-summary"
          ref={errorSummaryRef}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          tabIndex={-1}
          className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-700 p-3 space-y-1"
        >
          <p className="text-sm font-semibold text-red-800 dark:text-red-300 flex items-center gap-1">
            <AlertCircle size={14} aria-hidden="true" />
            Please fix the following before continuing:
          </p>
          <ul className="list-disc list-inside space-y-1">
            {hasDateError && (
              <li className="text-sm text-red-700 dark:text-red-400">
                <a
                  href="#check-in"
                  onClick={(e) => { e.preventDefault(); document.getElementById('check-in')?.focus(); }}
                  className="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
                >
                  {dateError || availabilityError}
                </a>
              </li>
            )}
            {guestError && (
              <li className="text-sm text-red-700 dark:text-red-400">
                <a
                  href="#guests"
                  onClick={(e) => { e.preventDefault(); document.getElementById('guests')?.focus(); }}
                  className="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
                >
                  {guestError}
                </a>
              </li>
            )}
          </ul>
        </div>
      )}

      {/* ── Date fields ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="check-in"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            <Calendar className="inline mr-1.5" size={15} aria-hidden="true" />
            {t('checkIn')}
            <span aria-hidden="true" className="ml-1 text-red-500">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="check-in"
            type="date"
            min={today}
            value={checkIn}
            onChange={(e) => setCheckIn(e.target.value)}
            required
            aria-required
            aria-invalid={hasDateError || undefined}
            aria-describedby={hasDateError ? 'booking-date-error' : undefined}
            className={`w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              hasDateError
                ? 'border-red-400 dark:border-red-600'
                : 'border-gray-300 dark:border-gray-600'
            }`}
          />
        </div>
        <div>
          <label
            htmlFor="check-out"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            <Calendar className="inline mr-1.5" size={15} aria-hidden="true" />
            {t('checkOut')}
            <span aria-hidden="true" className="ml-1 text-red-500">*</span>
            <span className="sr-only">(required)</span>
          </label>
          <input
            id="check-out"
            type="date"
            min={checkIn || today}
            value={checkOut}
            onChange={(e) => setCheckOut(e.target.value)}
            required
            aria-required
            aria-invalid={hasDateError || undefined}
            aria-describedby={hasDateError ? 'booking-date-error' : undefined}
            className={`w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              hasDateError
                ? 'border-red-400 dark:border-red-600'
                : 'border-gray-300 dark:border-gray-600'
            }`}
          />
        </div>
      </div>

      {/* Date / availability error — associated with both date inputs */}
      {hasDateError && (
        <p
          id="booking-date-error"
          role="alert"
          aria-live="polite"
          className="flex items-center gap-1.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertCircle size={14} aria-hidden="true" />
          {dateError || availabilityError}
        </p>
      )}

      {/* ── Guest count ─────────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="guests"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          <Users className="inline mr-1.5" size={15} aria-hidden="true" />
          Guests
          {maxGuests !== undefined && (
            <span
              id="guests-hint"
              className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400"
            >
              (max {maxGuests})
            </span>
          )}
          <span aria-hidden="true" className="ml-1 text-red-500">*</span>
          <span className="sr-only">(required)</span>
        </label>
        <input
          id="guests"
          type="number"
          min="1"
          step="1"
          max={maxGuests}
          value={guestCount}
          onChange={handleGuestChange}
          required
          aria-required
          aria-invalid={!!guestError || undefined}
          aria-describedby={buildDescribedBy('guests', !!guestError, !!maxGuests)}
          className={`w-full border rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            guestError
              ? 'border-red-400 bg-red-50 dark:bg-red-950/30 dark:border-red-700'
              : 'border-gray-300 dark:border-gray-600'
          }`}
        />
        {guestError && (
          <p
            id="guests-error"
            role="alert"
            aria-live="polite"
            className="mt-1 text-sm text-red-600 dark:text-red-400 flex items-center gap-1"
          >
            <AlertCircle size={13} aria-hidden="true" />
            {guestError}
          </p>
        )}
      </div>

      {/* ── Pricing breakdown ─────────────────────────────────────────────── */}
      {pricing && (
        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg space-y-2">
          {displayCurrency !== 'USD' && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
              Charges are always in{' '}
              <span className="font-semibold text-blue-600 dark:text-blue-400">USDC</span>.
              {' '}Local-currency figures are{' '}
              <span className="italic">estimates only</span>
              {ratesStale && (
                <span className="ml-1 text-amber-500 dark:text-amber-400">
                  (rates may be outdated)
                </span>
              )}
              .
            </p>
          )}

          {pricing.breakdown.length > 0 && (
            <div className="max-h-24 overflow-y-auto text-xs space-y-1 mb-3 pb-2 border-b border-gray-200 dark:border-gray-700">
              {pricing.breakdown.map((day) => (
                <div key={day.date} className="flex justify-between text-gray-600 dark:text-gray-400">
                  <span>{day.date}</span>
                  <span>
                    {day.is_available ? (
                      <>
                        {formatCurrency(day.price, locale)} USDC
                        {displayCurrency !== 'USD' && formatEstimate(day.price) && (
                          <span className="ml-1 text-gray-400 dark:text-gray-500">
                            {formatEstimate(day.price)}
                          </span>
                        )}
                      </>
                    ) : (
                      day.reason ?? 'Unavailable'
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
            <div className="flex justify-between">
              <span>
                {formatCurrency(pricing.base_nightly_rate, locale)} &times; {pricing.nights}{' '}
                {pricing.nights === 1 ? 'night' : 'nights'}
              </span>
              <span className="text-right">
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {formatCurrency(pricing.subtotal, locale)} USDC
                </span>
                {displayCurrency !== 'USD' && formatEstimate(pricing.subtotal) && (
                  <span className="block text-xs text-gray-400 dark:text-gray-500 italic">
                    {formatEstimate(pricing.subtotal)} (estimate)
                  </span>
                )}
              </span>
            </div>

            {pricing.dynamic_adjustments !== 0 && (
              <div className="flex justify-between">
                <span>Dynamic pricing</span>
                <span className="text-right">
                  <span className="font-medium text-gray-800 dark:text-gray-200">
                    {pricing.dynamic_adjustments > 0 ? '+' : ''}
                    {formatCurrency(pricing.dynamic_adjustments, locale)} USDC
                  </span>
                  {displayCurrency !== 'USD' && formatEstimate(Math.abs(pricing.dynamic_adjustments)) && (
                    <span className="block text-xs text-gray-400 dark:text-gray-500 italic">
                      {pricing.dynamic_adjustments > 0 ? '+' : '-'}
                      {formatEstimate(Math.abs(pricing.dynamic_adjustments))} (estimate)
                    </span>
                  )}
                </span>
              </div>
            )}

            <div className="flex justify-between">
              <span>Platform fee ({(pricing.platform_fee_pct * 100).toFixed(0)}%)</span>
              <span className="text-right">
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {formatCurrency(pricing.platform_fee, locale)} USDC
                </span>
                {displayCurrency !== 'USD' && formatEstimate(pricing.platform_fee) && (
                  <span className="block text-xs text-gray-400 dark:text-gray-500 italic">
                    {formatEstimate(pricing.platform_fee)} (estimate)
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="border-t pt-2 flex justify-between items-start font-semibold">
            <span>Total (charged in USDC)</span>
            <span className="text-right">
              <span className="text-blue-600 dark:text-blue-400">
                {formatCurrency(pricing.total, locale)} USDC
              </span>
              {displayCurrency !== 'USD' && formatEstimate(pricing.total) && (
                <span className="block text-xs font-normal text-gray-500 dark:text-gray-400 italic">
                  {formatEstimate(pricing.total)} (estimate)
                </span>
              )}
            </span>
          </div>
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading || nights <= 0 || !pricing || !!guestError || isOverCapacity || stayViolation}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition min-h-[44px]"
        aria-busy={isLoading}
        aria-disabled={isLoading || nights <= 0 || !pricing || !!guestError || isOverCapacity || stayViolation}
      >
        {isLoading ? t('processing') : t('bookNow')}
      </button>

      {/* ── Payment error display ────────────────────────────────────────── */}
      {/* Shown after the wallet/payment step fails. Uses the shared taxonomy
          to give the user a safe, actionable message without exposing internals. */}
      {paymentError != null && (
        <PaymentErrorDisplay
          error={paymentError}
          currentPaymentStatus={currentPaymentStatus}
          onRetry={onRetryPayment}
        />
      )}
    </form>
  );
}
