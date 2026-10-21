'use client';

/**
 * useWalletAccountGuard
 *
 * Detects when the user switches Freighter accounts while the app is open and
 * enforces the following rules:
 *
 * 1. The active Freighter address is polled every POLL_INTERVAL_MS (default
 *    2 s) and whenever the window regains focus — Freighter does not emit
 *    reliable events for account changes, so polling is the safest approach.
 * 2. When the active address diverges from the one stored in wallet state, the
 *    account-changed callback fires and wallet state is refreshed.
 * 3. Any stale signed quote or pending booking operation tied to the previous
 *    address must be invalidated by the calling component — this hook exposes
 *    `accountChanged` and `previousAddress` so callers can act on the switch.
 * 4. A disconnect clears local wallet state without touching unrelated
 *    account data (booking history, preferences, etc.).
 *
 * Usage:
 *   const { accountChanged, previousAddress } = useWalletAccountGuard();
 *   useEffect(() => {
 *     if (accountChanged) { // invalidate pending quotes, redirect, etc. }
 *   }, [accountChanged]);
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { getFreighterPublicKey, FreighterError } from '@/lib/freighter-utils';
import { useWalletContext } from '@/context/WalletContext';

const POLL_INTERVAL_MS = 2_000;

export interface UseWalletAccountGuardReturn {
  /** True for one render cycle after an account switch is detected. */
  accountChanged: boolean;
  /** The address that was active before the switch; null if no switch yet. */
  previousAddress: string | null;
}

export function useWalletAccountGuard(): UseWalletAccountGuardReturn {
  const { state, checkStatus, disconnect } = useWalletContext();
  const trackedAddressRef = useRef<string | null>(state.address);
  const [accountChanged, setAccountChanged] = useState(false);
  const [previousAddress, setPreviousAddress] = useState<string | null>(null);

  // Keep the ref in sync with external state changes (e.g. initial connect).
  useEffect(() => {
    if (state.address && trackedAddressRef.current === null) {
      trackedAddressRef.current = state.address;
    }
  }, [state.address]);

  const detectSwitch = useCallback(async () => {
    // Only monitor when the wallet is connected.
    if (!state.isConnected) return;

    try {
      const currentAddress = await getFreighterPublicKey();

      if (
        trackedAddressRef.current !== null &&
        currentAddress !== trackedAddressRef.current
      ) {
        // Account switched — record the previous address before refreshing.
        const prev = trackedAddressRef.current;
        trackedAddressRef.current = currentAddress;

        setPreviousAddress(prev);
        setAccountChanged(true);

        // Refresh wallet state so the UI shows the new address and re-validates
        // network consistency.
        await checkStatus();

        // Reset accountChanged flag on the next tick so callers get a single
        // render cycle to react.
        setTimeout(() => setAccountChanged(false), 0);
      }
    } catch (err) {
      if (err instanceof FreighterError && err.code === 'NOT_CONNECTED') {
        // The user fully disconnected from Freighter — clear local state but
        // do not delete any account-specific data (bookings, preferences).
        trackedAddressRef.current = null;
        disconnect();
      }
      // Other errors (rate limits, network glitch) — skip silently.
    }
  }, [state.isConnected, checkStatus, disconnect]);

  // Interval-based polling.
  useEffect(() => {
    if (!state.isConnected) return;

    const interval = setInterval(detectSwitch, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [state.isConnected, detectSwitch]);

  // Focus-based check — catches switches made while the tab was backgrounded.
  useEffect(() => {
    window.addEventListener('focus', detectSwitch);
    return () => window.removeEventListener('focus', detectSwitch);
  }, [detectSwitch]);

  return { accountChanged, previousAddress };
}
