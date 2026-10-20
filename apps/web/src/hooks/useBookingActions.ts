'use client';

import { useState, useCallback } from 'react';
import type { Booking } from '@/types/booking';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

type ActionType = 'confirm' | 'complete' | 'cancel' | 'dispute';

/** Actions that are safe to offer after a failed booking mutation. */
export type SafeRecoveryAction = 'retry' | 'change-wallet' | 'cancel' | 'support';

interface UseBookingActionsResult {
  /** Currently executing action (or null) */
  pendingAction: ActionType | null;
  /** Latest error message (or null) */
  actionError: string | null;
  /** Recovery actions that are safe for the current failure (empty when none) */
  safeActions: SafeRecoveryAction[];
  /** Confirm check-in — transitions Pending → Confirmed */
  confirm: () => Promise<Booking | null>;
  /** Complete stay — transitions Confirmed → Completed */
  complete: () => Promise<Booking | null>;
  /** Cancel — transitions Pending|Confirmed → Cancelled */
  cancel: () => Promise<Booking | null>;
  /** Dispute — transitions Confirmed → Disputed */
  dispute: (reason?: string) => Promise<Booking | null>;
  clearError: () => void;
}

/**
 * Hook that wraps all booking lifecycle mutation calls for a single booking.
 *
 * @param bookingId - UUID of the booking to act on
 * @param onSuccess - Optional callback fired with the updated booking after each action
 */
export function useBookingActions(
  bookingId: string,
  onSuccess?: (updated: Booking) => void,
): UseBookingActionsResult {
  const [pendingAction, setPendingAction] = useState<ActionType | null>(null);
  const [actionError, setActionError]     = useState<string | null>(null);
  const [safeActions, setSafeActions]     = useState<SafeRecoveryAction[]>([]);

  const clearError = useCallback(() => {
    setActionError(null);
    setSafeActions([]);
  }, []);

  const call = useCallback(
    async (
      action: ActionType,
      body?: Record<string, unknown>,
      idempotencyKey?: string,
    ): Promise<Booking | null> => {
      setPendingAction(action);
      setActionError(null);
      setSafeActions([]);

      // Reuse the caller-supplied key on retry so a payment is never duplicated.
      const key = idempotencyKey ?? generateIdempotencyKey();

      try {
        const url = `${API_BASE}/api/v1/bookings/${bookingId}/${action}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Idempotency-Key': key,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const json = await res.json();

        if (!res.ok) {
          const category = classifyError(res.status, json);
          setActionError(messageForCategory(category, action));
          setSafeActions(safeActionsForCategory(category));
          return null;
        }

        const updated = json as Booking;
        onSuccess?.(updated);
        return updated;
      } catch (err) {
        const category = classifyError(undefined, undefined, err);
        setActionError(messageForCategory(category, action));
        setSafeActions(safeActionsForCategory(category));
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [bookingId, onSuccess],
  );

  const confirm  = useCallback(() => call('confirm'),            [call]);
  const complete = useCallback(() => call('complete'),           [call]);
  const cancel   = useCallback(() => call('cancel'),             [call]);
  const dispute  = useCallback(
    (reason?: string) => call('dispute', reason ? { reason } : undefined),
    [call],
  );

  return {
    pendingAction,
    actionError,
    safeActions,
    confirm,
    complete,
    cancel,
    dispute,
    clearError,
  };
}

/** Error categories that drive user-facing messaging and safe recovery actions. */
type ErrorCategory =
  | 'wallet-rejected'
  | 'insufficient-funds'
  | 'rpc-failure'
  | 'provider-timeout'
  | 'contract-rejected'
  | 'network'
  | 'unknown';

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function classifyError(status?: number, json?: unknown, err?: unknown): ErrorCategory {
  const code =
    json && typeof json === 'object' && 'code' in json
      ? String((json as { code?: unknown }).code ?? '')
      : '';

  if (code === 'WALLET_REJECTED' || code === 'USER_REJECTED') return 'wallet-rejected';
  if (code === 'INSUFFICIENT_FUNDS') return 'insufficient-funds';
  if (code === 'RPC_FAILURE') return 'rpc-failure';
  if (code === 'PROVIDER_TIMEOUT') return 'provider-timeout';
  if (code === 'CONTRACT_REJECTED') return 'contract-rejected';

  if (status === 402) return 'insufficient-funds';
  if (status === 408 || status === 504) return 'provider-timeout';
  if (status === 502 || status === 503) return 'rpc-failure';
  if (status === 422) return 'contract-rejected';

  if (err instanceof Error && /timeout|timed out/i.test(err.message)) return 'provider-timeout';
  if (err instanceof TypeError) return 'network';

  return 'unknown';
}

function messageForCategory(category: ErrorCategory, action: ActionType): string {
  switch (category) {
    case 'wallet-rejected':
      return 'Your wallet rejected the request. Nothing was submitted.';
    case 'insufficient-funds':
      return 'Insufficient funds to complete this payment. No charge was made.';
    case 'rpc-failure':
      return 'The network could not process the request. Your payment was not confirmed.';
    case 'provider-timeout':
      return 'The payment provider timed out. The outcome is unconfirmed — check before retrying.';
    case 'contract-rejected':
      return 'The contract rejected this transaction. No payment was taken.';
    case 'network':
      return 'Network error. Please check your connection and try again.';
    default:
      return `Could not ${action} booking. Please try again or contact support.`;
  }
}

function safeActionsForCategory(category: ErrorCategory): SafeRecoveryAction[] {
  switch (category) {
    case 'wallet-rejected':
      return ['retry', 'change-wallet', 'cancel'];
    case 'insufficient-funds':
      return ['change-wallet', 'cancel', 'support'];
    case 'rpc-failure':
      return ['retry', 'support'];
    case 'provider-timeout':
      // Outcome unconfirmed — never offer retry to avoid duplicate payments.
      return ['support', 'cancel'];
    case 'contract-rejected':
      return ['cancel', 'support'];
    case 'network':
      return ['retry', 'support'];
    default:
      return ['support'];
  }
}
