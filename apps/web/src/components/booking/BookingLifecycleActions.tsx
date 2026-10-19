'use client';

import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { normaliseStatus, TENANT_TRANSITIONS } from '@/types/booking';
import type { Booking } from '@/types/booking';
import { useBookingActions } from '@/hooks/useBookingActions';

interface Props {
  booking: Booking;
  onBookingUpdated: (updated: Booking) => void;
}

interface RefundPreview {
  tier: 'full' | 'partial' | 'none';
  refundPct: number;
  refundAmount: number;
  totalPrice: number;
  hoursUntilCheckIn: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Renders the set of lifecycle action buttons appropriate for the current
 * booking state.  Only buttons valid in the current state are shown.
 *
 * State machine (tenant actions):
 *   Pending   → [Cancel]
 *   Confirmed → [Complete, Dispute, Cancel]
 *   Completed → (no actions)
 *   Cancelled → (no actions)
 *   Disputed  → (no actions — awaiting admin resolution)
 */
export default function BookingLifecycleActions({ booking, onBookingUpdated }: Props) {
  const [disputeReason, setDisputeReason] = useState('');
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [refundPreview, setRefundPreview] = useState<RefundPreview | null>(null);
  const [refundPreviewLoading, setRefundPreviewLoading] = useState(false);
  const [refundPreviewError, setRefundPreviewError] = useState<string | null>(null);

  const status      = normaliseStatus(booking.status);
  const transitions = TENANT_TRANSITIONS[status] ?? [];

  const { pendingAction, actionError, confirm, complete, cancel, dispute, clearError } =
    useBookingActions(booking.id, (updated) => {
      onBookingUpdated(updated);
      setShowDisputeForm(false);
      setShowCancelConfirm(false);
    });

  const isLoading = pendingAction !== null;

  // Fetch refund preview from the booking-time policy snapshot when the
  // cancel confirmation dialog is shown (#769).
  useEffect(() => {
    if (!showCancelConfirm) {
      setRefundPreview(null);
      setRefundPreviewError(null);
      return;
    }

    let cancelled = false;
    setRefundPreviewLoading(true);
    setRefundPreviewError(null);

    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    fetch(`${API_BASE}/api/v1/bookings/${booking.id}/refund-preview`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error('Failed to fetch refund preview')))
      .then((data: RefundPreview) => {
        if (!cancelled) setRefundPreview(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRefundPreview(null);
          setRefundPreviewError(error instanceof Error ? error.message : 'Refund calculation is unavailable');
        }
      })
      .finally(() => {
        if (!cancelled) setRefundPreviewLoading(false);
      });

    return () => { cancelled = true; };
  }, [showCancelConfirm, booking.id]);

  if (transitions.length === 0) return null;

  const handleDispute = async () => {
    if (!disputeReason.trim()) return;
    await dispute(disputeReason.trim());
  };

  return (
    <div className="space-y-4">
      {/* Error banner */}
      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950
            border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm"
        >
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{actionError}</span>
          <button
            onClick={clearError}
            className="ml-auto text-red-500 hover:text-red-700 focus:outline-none"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        {/* Confirm */}
        {transitions.includes('confirm') && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => confirm()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white
              text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition
              focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            {pendingAction === 'confirm' ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={15} aria-hidden="true" />
            )}
            Confirm check-in
          </button>
        )}

        {/* Complete */}
        {transitions.includes('complete') && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => complete()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white
              text-sm font-medium hover:bg-green-700 disabled:opacity-50 transition
              focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
          >
            {pendingAction === 'complete' ? (
              <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 size={15} aria-hidden="true" />
            )}
            Mark as completed
          </button>
        )}

        {/* Dispute */}
        {transitions.includes('dispute') && !showDisputeForm && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => { setShowDisputeForm(true); setShowCancelConfirm(false); clearError(); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-400
              text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40
              text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50 transition
              focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            <AlertTriangle size={15} aria-hidden="true" />
            Open dispute
          </button>
        )}

        {/* Cancel */}
        {transitions.includes('cancel') && !showCancelConfirm && (
          <button
            type="button"
            disabled={isLoading}
            onClick={() => { setShowCancelConfirm(true); setShowDisputeForm(false); clearError(); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300
              dark:border-gray-600 text-gray-700 dark:text-gray-300
              text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition
              focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <XCircle size={15} aria-hidden="true" />
            Cancel booking
          </button>
        )}
      </div>

      {/* Cancel confirmation inline */}
      {showCancelConfirm && (
        <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 space-y-3">
          <p className="text-sm text-gray-800 dark:text-gray-200 font-medium">
            Are you sure you want to cancel this booking?
          </p>

          {/* Refund preview from booking-time policy snapshot (#769) */}
          {refundPreviewLoading && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 size={12} className="animate-spin" aria-hidden="true" />
              Calculating refund…
            </div>
          )}
          {!refundPreviewLoading && refundPreview && (
            <div className="p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-gray-400">Refund tier</span>
                <span className={`text-xs font-medium capitalize ${
                  refundPreview.tier === 'full' ? 'text-green-600'
                  : refundPreview.tier === 'partial' ? 'text-amber-600'
                  : 'text-red-600'
                }`}>
                  {refundPreview.tier} ({Math.round(refundPreview.refundPct * 100)}%)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-gray-400">Refund amount</span>
                <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {refundPreview.refundAmount.toFixed(2)} USDC
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-600 dark:text-gray-400">Total price</span>
                <span className="text-xs text-gray-700 dark:text-gray-300">
                  {refundPreview.totalPrice.toFixed(2)} USDC
                </span>
              </div>
              {refundPreview.hoursUntilCheckIn > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600 dark:text-gray-400">Hours until check-in</span>
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    {Math.round(refundPreview.hoursUntilCheckIn)}h
                  </span>
                </div>
              )}
            </div>
          )}
          {!refundPreviewLoading && refundPreviewError && (
            <p role="alert" className="text-xs text-red-700 dark:text-red-300">
              {refundPreviewError}. Refresh the preview before cancelling.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isLoading || refundPreviewLoading || !refundPreview || !!refundPreviewError}
              onClick={() => cancel()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white
                text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition
                focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              {pendingAction === 'cancel' ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : null}
              Yes, cancel
            </button>
            <button
              type="button"
              onClick={() => setShowCancelConfirm(false)}
              className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm
                text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700
                focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Keep booking
            </button>
          </div>
        </div>
      )}

      {/* Dispute form inline */}
      {showDisputeForm && (
        <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800
          bg-amber-50 dark:bg-amber-950/30 space-y-3">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Open a dispute
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Describe the issue. Your escrow funds will be held until an admin reviews and resolves
            the dispute.
          </p>
          <textarea
            rows={3}
            value={disputeReason}
            onChange={(e) => setDisputeReason(e.target.value)}
            placeholder="Describe the issue with this booking…"
            aria-label="Dispute reason"
            className="w-full border border-amber-300 dark:border-amber-700 rounded-lg px-3 py-2 text-sm
              bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none
              focus:outline-none focus:ring-2 focus:ring-amber-500"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isLoading || !disputeReason.trim()}
              onClick={handleDispute}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white
                text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition
                focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              {pendingAction === 'dispute' ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : null}
              Submit dispute
            </button>
            <button
              type="button"
              onClick={() => { setShowDisputeForm(false); setDisputeReason(''); }}
              className="px-4 py-2 rounded-lg border border-amber-300 dark:border-amber-700 text-sm
                text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40
                focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
