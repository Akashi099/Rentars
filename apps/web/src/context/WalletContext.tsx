'use client';

import { createContext, useContext, ReactNode, useEffect, useCallback, useRef } from 'react';
import { useWallet, UseWalletReturn } from '@/hooks/useWallet';
import { getFreighterPublicKey, FreighterError } from '@/lib/freighter-utils';

const ACCOUNT_POLL_INTERVAL_MS = 2_000;

interface WalletContextType extends UseWalletReturn {
    isReady: boolean;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
    const wallet = useWallet();
    const isReady = !wallet.state.isLoading;

    // ── Account-switching guard ────────────────────────────────────────────
    // Poll Freighter for the active address on an interval and on window focus.
    // When it diverges from the stored address, refresh wallet state so the UI
    // reflects the change immediately and any stale operation context is cleared.
    const trackedAddressRef = useRef<string | null>(wallet.state.address);

    // Keep the ref in sync when state changes externally (initial connect).
    useEffect(() => {
        if (wallet.state.address !== null) {
            trackedAddressRef.current = wallet.state.address;
        }
    }, [wallet.state.address]);

    const detectAccountSwitch = useCallback(async () => {
        if (!wallet.state.isConnected) return;
        try {
            const currentAddress = await getFreighterPublicKey();
            if (
                trackedAddressRef.current !== null &&
                currentAddress !== trackedAddressRef.current
            ) {
                trackedAddressRef.current = currentAddress;
                // Re-check full status (network + address) so state is consistent.
                await wallet.checkStatus();
            }
        } catch (err) {
            if (err instanceof FreighterError && err.code === 'NOT_CONNECTED') {
                // User fully disconnected inside Freighter — clear state without
                // removing unrelated account data.
                trackedAddressRef.current = null;
                wallet.disconnect();
            }
        }
    }, [wallet]);

    // Interval polling.
    useEffect(() => {
        if (!wallet.state.isConnected) return;
        const interval = setInterval(detectAccountSwitch, ACCOUNT_POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [wallet.state.isConnected, detectAccountSwitch]);

    // Focus-based check — fires after tab regains focus.
    useEffect(() => {
        window.addEventListener('focus', detectAccountSwitch);
        return () => window.removeEventListener('focus', detectAccountSwitch);
    }, [detectAccountSwitch]);

    // Auto-check status on Stellar network-change events.
    useEffect(() => {
        const handleNetworkChange = () => {
            wallet.checkStatus();
        };

        window.addEventListener('stellar-network-change', handleNetworkChange);
        return () => window.removeEventListener('stellar-network-change', handleNetworkChange);
    }, [wallet]);

    return (
        <WalletContext.Provider value={{ ...wallet, isReady }}>
            {children}
        </WalletContext.Provider>
    );
}

export function useWalletContext() {
    const context = useContext(WalletContext);
    if (context === undefined) {
        throw new Error('useWalletContext must be used within a WalletProvider');
    }
    return context;
}