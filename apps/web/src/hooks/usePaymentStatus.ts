'use client';

/**
 * usePaymentStatus
 *
 * Polls the backend payment-status endpoint until the payment reaches a
 * terminal state (confirmed, failed) or the optional deadline is exceeded.
 *
 * Design:
 * - Polls every POLL_INTERVAL_MS while status is 'submitted' or 'pending'.
 * - Distinguishes 'submitted' (broadcast, awaiting ledger) from 'confirmed'
 *   (on-chain success) so the UI never misleads the user about finality.
 * - A polling timeout does NOT report the payment as failed — it reports
 *   'poll_timeout' so callers know reconciliation may still succeed later.
 * - All updates are idempotent; duplicate confirmed events are safe.
 *
 * Usage:
 *   const { paymentStatus, txHash, isPolling, error } = usePaymentStatus({
 *     paymentId: 'uuid',
 *     enabled: true,          // start polling immediately
 *     onConfirmed: (txHash) => toast.success(`Confirmed: ${txHash}`),
 *     onFailed: (status) => toast.error(`Payment ${status}`),
 *   });
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** All possible payment status values as returned by the backend. */
export type PaymentStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'timed_out'
  | 'refunded'
  | 'under_review'
  // Client-side sentinel: polling deadline exceeded before backend settled.
  | 'poll_timeout';

const TERMINAL_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  'confirmed',
  'failed',
  'timed_out',
  'refunded',
  'under_review',
  'poll_timeout',
]);

const POLL_INTERVAL_MS = 3_000;
/** Maximum time the client will poll before giving up. Backend may still
 *  settle the payment afterwards — poll_timeout is NOT a final failure. */
const POLL_DEADLINE_MS = 5 * 60 * 1_000; // 5 minutes

export interface UsePaymentStatusOptions {
  paymentId: string | null;
  /** Set to false to pause polling (e.g. while another step is pending). */
  enabled?: boolean;
  onConfirmed?: (txHash: string) => void;
  onFailed?: (status: PaymentStatus) => void;
}

export interface UsePaymentStatusReturn {
  paymentStatus: PaymentStatus | null;
  txHash: string | null;
  isPolling: boolean;
  error: string | null;
  /** Manually re-trigger a poll (e.g. after user taps "Check status"). */
  refresh: () => void;
}

export function usePaymentStatus({
  paymentId,
  enabled = true,
  onConfirmed,
  onFailed,
}: UsePaymentStatusOptions): UsePaymentStatusReturn {
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const latestStatusRef = useRef<PaymentStatus | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const poll = useCallback(async () => {
    if (!paymentId) return;

    // Enforce client-side deadline.
    if (deadlineRef.current !== null && Date.now() > deadlineRef.current) {
      stopPolling();
      setPaymentStatus('poll_timeout');
      latestStatusRef.current = 'poll_timeout';
      onFailed?.('poll_timeout');
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/payments/${paymentId}/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) {
        if (res.status === 404) {
          setError('Payment record not found');
          stopPolling();
          return;
        }
        // Transient error — keep polling.
        return;
      }

      const data: {
        paymentId: string;
        status: PaymentStatus;
        txHash: string | null;
      } = await res.json();

      const newStatus = data.status;

      // Guard against stale responses racing with a newer update.
      if (newStatus === latestStatusRef.current) return;

      latestStatusRef.current = newStatus;
      setPaymentStatus(newStatus);
      if (data.txHash) setTxHash(data.txHash);

      if (TERMINAL_STATUSES.has(newStatus)) {
        stopPolling();
        if (newStatus === 'confirmed') {
          onConfirmed?.(data.txHash ?? '');
        } else {
          onFailed?.(newStatus);
        }
      }
    } catch {
      // Network error — keep polling; don't surface transient failures.
    }
  }, [paymentId, onConfirmed, onFailed, stopPolling]);

  const refresh = useCallback(() => {
    poll();
  }, [poll]);

  useEffect(() => {
    if (!paymentId || !enabled) {
      stopPolling();
      return;
    }

    // Reset when the paymentId changes.
    setPaymentStatus(null);
    setTxHash(null);
    setError(null);
    latestStatusRef.current = null;
    deadlineRef.current = Date.now() + POLL_DEADLINE_MS;

    // Immediate first poll so the UI does not wait POLL_INTERVAL_MS.
    poll();

    setIsPolling(true);
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return stopPolling;
  }, [paymentId, enabled, poll, stopPolling]);

  return { paymentStatus, txHash, isPolling, error, refresh };
}
