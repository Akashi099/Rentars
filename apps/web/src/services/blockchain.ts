const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Semantic status states shared across the design system.
 * These map to the semantic color tokens (success/warning/error/pending/focus)
 * and are always paired with a non-color cue (icon + label) in the UI so that
 * status remains understandable without color perception.
 */
export type BlockchainStatusState = 'success' | 'pending' | 'error';

/**
 * Non-color cues that accompany each status state. Consumers should render
 * these (icon name + human-readable label) alongside the semantic token so
 * state is communicated independently of color.
 */
export interface BlockchainStatusCue {
  /** Semantic token name, e.g. `--color-status-success`. */
  token: string;
  /** Icon identifier used by the shared icon set. */
  icon: 'check-circle' | 'clock' | 'alert-triangle';
  /** Human-readable label announced to assistive tech and shown in UI. */
  label: string;
}

export const BLOCKCHAIN_STATUS_CUES: Record<BlockchainStatusState, BlockchainStatusCue> = {
  success: {
    token: '--color-status-success',
    icon: 'check-circle',
    label: 'Verified',
  },
  pending: {
    token: '--color-status-pending',
    icon: 'clock',
    label: 'Verification pending',
  },
  error: {
    token: '--color-status-error',
    icon: 'alert-triangle',
    label: 'Verification failed',
  },
};

export interface BlockchainStatus {
  verified: boolean;
  hash: string | null;
  lastVerified: string | null;
  pending: boolean;
  failed?: boolean;
  failureReason?: string | null;
  /** Derived semantic state for consistent token + non-color cue rendering. */
  state: BlockchainStatusState;
  /** Non-color cue (icon + label + token) for the derived state. */
  cue: BlockchainStatusCue;
}

/**
 * Derives the semantic status state from the raw blockchain status payload.
 * Precedence: explicit failure > pending > verified success > error fallback.
 */
export function deriveBlockchainStatusState(
  status: Pick<BlockchainStatus, 'verified' | 'pending' | 'failed'>,
): BlockchainStatusState {
  if (status.failed) {
    return 'error';
  }
  if (status.pending) {
    return 'pending';
  }
  if (status.verified) {
    return 'success';
  }
  return 'error';
}

/**
 * Normalizes a raw API payload into a fully typed BlockchainStatus, ensuring
 * the semantic `state` and `cue` are always present.
 */
function normalizeBlockchainStatus(
  raw: Omit<BlockchainStatus, 'state' | 'cue'> & Partial<Pick<BlockchainStatus, 'state' | 'cue'>>,
): BlockchainStatus {
  const state = raw.state ?? deriveBlockchainStatusState(raw);
  return {
    ...raw,
    state,
    cue: raw.cue ?? BLOCKCHAIN_STATUS_CUES[state],
  };
}

export async function verifyProperty(propertyId: string): Promise<BlockchainStatus> {
  const response = await fetch(`${API_URL}/api/properties/${propertyId}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error('Failed to verify property');
  }

  const data = await response.json();
  return normalizeBlockchainStatus(data);
}

export async function getBlockchainStatus(propertyId: string): Promise<BlockchainStatus> {
  const response = await fetch(`${API_URL}/api/properties/${propertyId}/blockchain-status`);

  if (!response.ok) {
    throw new Error('Failed to fetch blockchain status');
  }

  const data = await response.json();
  return normalizeBlockchainStatus(data);
}