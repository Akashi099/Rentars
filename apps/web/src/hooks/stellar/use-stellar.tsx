'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import { deriveKeyFromPasskey } from '@/lib/passkey/stellar';
import { deployStellarSmartWallet } from '@/lib/passkey/deploy';
import { PASSKEY_WALLET_SUPPORTED, PasskeyUnsupportedError } from '@/lib/passkey/status';

interface StellarContextType {
  keypair: StellarSdk.Keypair | null;
  publicKey: string | null;
  network: 'testnet' | 'mainnet';
  onRegister: (registrationResponse: any) => Promise<void>;
  prepareSign: () => Promise<string>;
  onSign: (signParams: any) => Promise<string>;
  deployee: string | null;
  loadingDeployee: boolean;
  loadingRegister: boolean;
  loadingSign: boolean;
  /** False until a supported passkey provider exists. Callers must offer a fallback. */
  passkeySupported: boolean;
}

const StellarContext = createContext<StellarContextType | undefined>(undefined);

export function StellarProvider({
  children,
  network = 'testnet',
}: {
  children: ReactNode;
  network?: 'testnet' | 'mainnet';
}) {
  const [keypair, setKeypair] = useState<StellarSdk.Keypair | null>(null);
  const [deployee, setDeployee] = useState<string | null>(null);
  const [loadingDeployee, setLoadingDeployee] = useState(false);
  const [loadingRegister, setLoadingRegister] = useState(false);
  const [loadingSign, setLoadingSign] = useState(false);

  const onRegister = useCallback(
    async (registrationResponse: any) => {
      setLoadingRegister(true);
      try {
        // Fails closed: no keypair or wallet is created until a supported provider exists.
        const credentialId: string = registrationResponse?.id ?? '';
        const derivedKeypair = await deriveKeyFromPasskey(credentialId);
        setKeypair(derivedKeypair);

        setLoadingDeployee(true);
        const deploymentId = await deployStellarSmartWallet(derivedKeypair, network);
        setDeployee(deploymentId);
      } catch (err) {
        // Never keep a partially initialised identity after a failure.
        setKeypair(null);
        setDeployee(null);
        if (err instanceof PasskeyUnsupportedError) throw err;
        throw new PasskeyUnsupportedError('registration');
      } finally {
        setLoadingRegister(false);
        setLoadingDeployee(false);
      }
    },
    [network]
  );

  const prepareSign = useCallback(async (): Promise<string> => {
    // No placeholder XDR: a transaction can only be prepared once passkey signing exists.
    throw new PasskeyUnsupportedError('transaction preparation');
  }, []);

  const onSign = useCallback(async (_signParams: any): Promise<string> => {
    setLoadingSign(true);
    try {
      throw new PasskeyUnsupportedError('transaction signing');
    } finally {
      setLoadingSign(false);
    }
  }, []);

  return (
    <StellarContext.Provider
      value={{
        keypair,
        publicKey: keypair?.publicKey() || null,
        network,
        onRegister,
        prepareSign,
        onSign,
        deployee,
        loadingDeployee,
        loadingRegister,
        loadingSign,
        passkeySupported: PASSKEY_WALLET_SUPPORTED,
      }}
    >
      {children}
    </StellarContext.Provider>
  );
}

export function useStellar() {
  const context = useContext(StellarContext);
  if (!context) {
    throw new Error('useStellar must be used within StellarProvider');
  }
  return context;
}
