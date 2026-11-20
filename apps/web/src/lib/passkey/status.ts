/**
 * Passkey-to-Stellar wallets are not supported yet.
 *
 * No audited passkey provider has been selected, so every passkey entry point
 * fails closed with PasskeyUnsupportedError instead of producing a placeholder
 * key, transaction or signature. Flip this only together with a real provider
 * integration and its tests. See docs/passkey-wallet-decision.md.
 */
export const PASSKEY_WALLET_SUPPORTED = false as const;

export class PasskeyUnsupportedError extends Error {
  readonly code = 'PASSKEY_UNSUPPORTED' as const;

  constructor(operation: string) {
    super(
      `Passkey wallets are not available yet (${operation}). Sign in with your email or connect a Stellar wallet instead.`,
    );
    this.name = 'PasskeyUnsupportedError';
  }
}

export function isPasskeyUnsupportedError(err: unknown): err is PasskeyUnsupportedError {
  return err instanceof PasskeyUnsupportedError;
}
