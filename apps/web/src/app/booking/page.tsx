'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import BookingForm from '@/components/booking/BookingForm';
import WalletConnectionModal from '@/components/booking/WalletConnectionModal';
import HouseRulesAcknowledgement, {
  type HouseRules,
} from '@/components/booking/HouseRulesAcknowledgement';
import { TermsDisclosure, type TermsAcceptance } from '@/components/shared/TermsDisclosure';
import { ErrorState } from '@/components/ui/async-states';
import { isValidStellarAddress } from '@/lib/freighter-utils';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface BookingPayload {
  checkIn: Date;
  checkOut: Date;
  guestCount: number;
  totalPrice: number;
}

export default function BookingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const propertyId = searchParams.get('propertyId') || 'property-id';

  const [walletConnected, setWalletConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Synchronous re-entry guard: a double click (or Enter + click) that lands
  // before React re-renders the disabled button cannot create a second booking.
  const isSubmittingRef = useRef(false);
  // Remembered so a failed submission can be retried without losing or
  // re-entering any of the user's input.
  const lastBookingRef = useRef<BookingPayload | null>(null);

  // House rules state
  const [houseRules, setHouseRules] = useState<HouseRules | null>(null);
  const [rulesAcknowledgedAt, setRulesAcknowledgedAt] = useState('');
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const rulesLoadingRef = useRef(false);

  // Terms acceptance state
  const [termsAcceptance, setTermsAcceptance] = useState<TermsAcceptance | null>(null);

  // Check for existing wallet connection on mount
  useEffect(() => {
    const savedAddress = localStorage.getItem('walletAddress');
    if (savedAddress && isValidStellarAddress(savedAddress)) {
      setWalletAddress(savedAddress);
      setWalletConnected(true);
    }
  }, []);

  // Fetch property rules — failures are surfaced (not silently swallowed) with
  // a guarded retry, so users can tell "no rules" apart from "request failed".
  const fetchHouseRules = useCallback(async () => {
    if (!propertyId || propertyId === 'property-id') return;
    if (rulesLoadingRef.current) return;
    rulesLoadingRef.current = true;
    setRulesLoading(true);
    setRulesError(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/properties/${propertyId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('rules fetch failed');
      const data = await res.json();
      setHouseRules({
        pets_allowed: data.pets_allowed,
        smoking_allowed: data.smoking_allowed,
        events_allowed: data.events_allowed,
        quiet_hours_start: data.quiet_hours_start,
        quiet_hours_end: data.quiet_hours_end,
        additional_rules: data.additional_rules,
      });
    } catch {
      setRulesError(
        "We couldn't load the house rules for this property. You can still continue — please review them once they load.",
      );
    } finally {
      rulesLoadingRef.current = false;
      setRulesLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    fetchHouseRules();
  }, [fetchHouseRules]);

  const hasRulesToAcknowledge =
    houseRules !== null &&
    (houseRules.pets_allowed !== undefined ||
      houseRules.smoking_allowed !== undefined ||
      houseRules.events_allowed !== undefined ||
      houseRules.quiet_hours_start ||
      houseRules.additional_rules);

  const rulesGatePassed = !hasRulesToAcknowledge || !!rulesAcknowledgedAt;

  const submitBooking = useCallback(
    async (data: BookingPayload) => {
      if (isSubmittingRef.current) return;
      if (!walletConnected || !walletAddress) {
        setShowWalletModal(true);
        return;
      }

      if (!rulesGatePassed) {
        return; // button will be disabled, but guard anyway
      }

      if (!termsAcceptance) {
        return; // button will be disabled, but guard anyway
      }

      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setSubmitError(null);
      lastBookingRef.current = data;

      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${API_URL}/api/bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            property_id: propertyId,
            check_in: data.checkIn.toISOString(),
            check_out: data.checkOut.toISOString(),
            guest_count: data.guestCount,
            total_price: data.totalPrice,
            wallet_address: walletAddress,
            rules_acknowledged_at: rulesAcknowledgedAt || new Date().toISOString(),
            terms_version: termsAcceptance.termsVersion,
            terms_accepted_at: termsAcceptance.termsAcceptedAt,
          }),
        });

        if (response.ok) {
          const booking = await response.json();
          router.push(`/booking/confirmation/${booking.id}`);
          return;
        }

        // Prefer a safe message from the API; never leak internals.
        let message = "We couldn't create your booking. Nothing was charged — please try again.";
        try {
          const body = await response.json();
          if (typeof body?.error === 'string' && body.error.trim()) {
            message = body.error;
          } else if (typeof body?.error?.message === 'string' && body.error.message.trim()) {
            message = body.error.message;
          }
        } catch {
          // Non-JSON error body — keep the generic message.
        }
        setSubmitError(message);
      } catch (error) {
        console.error('Booking error:', error);
        setSubmitError(
          "We couldn't reach the booking service. Check your connection and try again — your details are kept.",
        );
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [walletConnected, walletAddress, rulesGatePassed, termsAcceptance, propertyId, rulesAcknowledgedAt, router],
  );

  const handleBookingSubmit = useCallback(
    (data: BookingPayload) => {
      void submitBooking(data);
    },
    [submitBooking],
  );

  // Safe retry: re-runs the exact same payload; submitBooking's re-entry guard
  // means a double click here still creates at most one booking.
  const handleRetryBooking = useCallback(() => {
    if (lastBookingRef.current) void submitBooking(lastBookingRef.current);
  }, [submitBooking]);

  const handleWalletConnect = (address: string) => {
    setWalletAddress(address);
    setWalletConnected(true);
  };

  const handleWalletDisconnect = () => {
    localStorage.removeItem('walletAddress');
    setWalletAddress(null);
    setWalletConnected(false);
  };

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 py-6 sm:py-8">
      <div className="max-w-2xl mx-auto px-4 pb-28 sm:pb-8">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white mb-2">
          Book your stay
        </h1>
        <p className="text-sm sm:text-base text-gray-600 dark:text-gray-400 mb-6 sm:mb-8">
          Confirm your dates and complete payment from your wallet.
        </p>

        {/* Wallet Status Card */}
        <div className="mb-6">
          {walletConnected && walletAddress ? (
            <div className="flex items-start gap-3 p-4 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
              <CheckCircle2 size={20} className="text-green-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-green-900 dark:text-green-200">Wallet connected</p>
                <p className="text-xs text-green-700 dark:text-green-400 mt-1 font-mono break-all">{walletAddress}</p>
                <button
                  onClick={handleWalletDisconnect}
                  className="text-xs text-green-600 dark:text-green-400 hover:text-green-700 mt-2 underline"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg">
              <AlertCircle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">No wallet connected</p>
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                  Connect a Freighter wallet to complete this booking.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* House rules fetch failure — visible, non-blocking, safe retry */}
        {rulesError && (
          <div className="mb-6">
            <ErrorState
              variant="inline"
              title="House rules unavailable"
              message={rulesError}
              onRetry={fetchHouseRules}
              retryLabel="Retry"
              retrying={rulesLoading}
            />
          </div>
        )}

        {/* House Rules — must be acknowledged before booking.
            On narrow viewports this secondary content collapses into an
            accessible disclosure so the primary form stays in view. */}
        {houseRules && (
          <div className="mb-6">
            <details
              className="sm:hidden rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
              open={!rulesGatePassed}
            >
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                House rules{rulesGatePassed ? ' (acknowledged)' : ' — review required'}
              </summary>
              <div className="px-4 pb-4">
                <HouseRulesAcknowledgement
                  rules={houseRules}
                  acknowledged={!!rulesAcknowledgedAt}
                  onAcknowledge={(ts) => setRulesAcknowledgedAt(ts)}
                />
              </div>
            </details>
            <div className="hidden sm:block">
              <HouseRulesAcknowledgement
                rules={houseRules}
                acknowledged={!!rulesAcknowledgedAt}
                onAcknowledge={(ts) => setRulesAcknowledgedAt(ts)}
              />
            </div>
          </div>
        )}

        {/* Booking error — inline (never overlapping the submit button),
            announced via role="alert", with a retry that cannot duplicate */}
        {submitError && (
          <div className="mb-6">
            <ErrorState
              variant="inline"
              message={submitError}
              onRetry={handleRetryBooking}
              retryLabel="Try booking again"
              retrying={isSubmitting}
            />
          </div>
        )}

        {/* Booking form — disabled when rules not yet acknowledged */}
        <div className={hasRulesToAcknowledge && !rulesGatePassed ? 'opacity-50 pointer-events-none' : ''}>
          {hasRulesToAcknowledge && !rulesGatePassed && (
            <p className="text-sm text-amber-700 mb-3 flex items-center gap-2">
              <AlertCircle size={15} aria-hidden="true" />
              Please acknowledge the house rules above to continue.
            </p>
          )}

          {/* Terms & Disclosures — must be accepted before confirming */}
          <div className="mb-6">
            <TermsDisclosure
              variant="booking"
              accepted={!!termsAcceptance}
              onAcceptanceChange={setTermsAcceptance}
            />
          </div>

          <BookingForm
            propertyId={propertyId}
            pricePerNight={100}
            onSubmit={handleBookingSubmit}
            isLoading={isSubmitting}
            disabled={!termsAcceptance}
          />
        </div>
      </div>

      {/* Sticky mobile action bar — keeps the primary action reachable without
          horizontal scrolling or being pushed off-screen by long content. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 dark:border-gray-800 bg-white/95 dark:bg-gray-900/95 backdrop-blur px-4 py-3 sm:hidden">
        {walletConnected && walletAddress ? (
          <button
            type="button"
            onClick={() => {
              const form = document.querySelector<HTMLFormElement>('form[data-booking-form]');
              if (form) {
                form.requestSubmit();
              } else {
                form?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            disabled={isSubmitting || !termsAcceptance || !rulesGatePassed}
            className="w-full min-h-[44px] rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            {isSubmitting ? 'Booking…' : 'Confirm booking'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowWalletModal(true)}
            className="w-full min-h-[44px] rounded-lg bg-blue-600 px-4 py-3 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          >
            Connect wallet to book
          </button>
        )}
      </div>

      <WalletConnectionModal
        isOpen={showWalletModal}
        onClose={() => setShowWalletModal(false)}
        onConnect={handleWalletConnect}
      />
    </main>
  );
}
