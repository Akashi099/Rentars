/**
 * Lazy-loaded wallet connector components.
 * 
 * Reduces initial bundle size by code-splitting Stellar SDK and Freighter wallet adapter.
 * Only loads when user initiates wallet connection.
 */

'use client';

import dynamic from 'next/dynamic';

export const WalletConnectButton = dynamic(
  () => import('@/components/wallet/WalletConnect').then((mod) => mod.WalletConnectButton),
  {
    loading: () => (
      <button
        disabled
        className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-400 rounded-lg cursor-not-allowed"
      >
        Loading wallet...
      </button>
    ),
    ssr: false,
  }
);

export const WalletModal = dynamic(
  () => import('@/components/wallet/WalletModal').then((mod) => mod.WalletModal),
  {
    loading: () => null,
    ssr: false,
  }
);
