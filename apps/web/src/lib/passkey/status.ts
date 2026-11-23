/**
 * Passkey-to-Stellar wallets are not supported yet.
 *
 * No audited passkey provider has been selected, so every passkey entry point
 * fails closed with PasskeyUnsupportedError instead of producing a placeholder
 * key, transaction or signature. Flip this only together with a real provider
 * integration and its tests. See docs/passkey-wallet-decision.md.
 */
export const PASSKEY_WALLET_SUPPORTED = false as const;

/**
 * Semantic status token for the unsupported passkey state.
 *
 * Uses the shared "warning" semantic token family (see global styles) rather
 * than ad-hoc colors, so light/dark themes stay consistent and contrast-checked.
 */
export const PASSKEY_STATUS_TOKEN = 'warning' as const;

/**
 * Non-color cues so the unsupported state is understandable without relying on
 * color perception. Consumers should render both the icon and the label.
 */
export const PASSKEY_STATUS_ICON = '⚠' as const;
export const PASSKEY_STATUS_LABEL = 'Unavailable' as const;

export interface PasskeyStatusDescriptor {
  /** Semantic token name (maps to shared design tokens). */
  token: typeof PASSKEY_STATUS_TOKEN;
  /** Icon cue rendered alongside any color. */
  icon: typeof PASSKEY_STATUS_ICON;
  /** Short text label communicated independently of color. */
  label: typeof PASSKEY_STATUS_LABEL;
  /** Human-readable message. */
  message: string;
}

export function getPasskeyStatusDescriptor(): PasskeyStatusDescriptor {
  return {
    token: PASSKEY_STATUS_TOKEN,
    icon: PASSKEY_STATUS_ICON,
    label: PASSKEY_STATUS_LABEL,
    message:
      'Passkey wallets are not available yet. Sign in with your email or connect a Stellar wallet instead.',
  };
}

export class PasskeyUnsupportedError extends Error {
  readonly code = 'PASSKEY_UNSUPPORTED' as const;
  readonly statusToken = PASSKEY_STATUS_TOKEN;
  readonly statusIcon = PASSKEY_STATUS_ICON;
  readonly statusLabel = PASSKEY_STATUS_LABEL;

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