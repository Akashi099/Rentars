'use client';

/**
 * PaymentErrorDisplay (#771)
 *
 * Renders a classified payment error with:
 *  - A safe, human-readable message (no internals, no stack traces)
 *  - Contextually correct action buttons (retry / change wallet / cancel / support)
 *  - Explicit "payment not duplicated" assurance when canRetry is true
 *  - Suppression of retry/resubmit when the payment is already submitted or confirmed
 *
 * Usage:
 *   <PaymentErrorDisplay
 *     error={thrownError}
 *     currentPaymentStatus="pending"
 *     onRetry={() => setStep('wallet')}
 *     onCancel={() => router.back()}
 *   />
 */

import { classifyPaymentError } from '@/lib/errors/paymentErrorTaxonomy';
import type {
  PaymentErrorClassification,
  SuggestedAction,
} from '@/lib/errors/paymentErrorTaxonomy';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface PaymentErrorDisplayProps {
  /** The raw error thrown by the payment or wallet flow. */
  error: unknown;
  /**
   * The latest known server-side payment status. Pass this to prevent retry
   * when the payment XDR is already on the network ('submitted') or confirmed.
   */
  currentPaymentStatus?: string;
  /** Called when the user chooses to retry the same payment. */
  onRetry?: () => void;
  /** Called when the user wants to switch to a different wallet. */
  onChangeWallet?: () => void;
  /** Called when the user cancels and goes back. */
  onCancel?: () => void;
  /** Optional href for the support link (e.g. mailto: or helpdesk URL). */
  supportUrl?: string;
}

// ─── Action button helpers ────────────────────────────────────────────────────

const SUPPORT_FALLBACK_URL = 'mailto:support@rentars.io';

interface ActionButtonsProps {
  classification: PaymentErrorClassification;
  onRetry?: () => void;
  onChangeWallet?: () => void;
  onCancel?: () => void;
  supportUrl?: string;
}

function ActionButtons({
  classification,
  onRetry,
  onChangeWallet,
  onCancel,
  supportUrl,
}: ActionButtonsProps) {
  const { canRetry, suggestedAction } = classification;

  // Never show a retry button when the error prevents retry (e.g. submitted/confirmed)
  const showRetry = canRetry && suggestedAction === 'retry' && onRetry;
  const showChangeWallet = !canRetry && suggestedAction === 'change_wallet' && onChangeWallet;
  const showSupport = suggestedAction === 'contact_support';
  const showCancel = onCancel && suggestedAction !== 'none';

  if (!showRetry && !showChangeWallet && !showSupport && !showCancel) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-4" role="group" aria-label="Payment error actions">
      {showRetry && (
        <Button
          onClick={onRetry}
          variant="default"
          aria-label="Retry payment"
        >
          Try again
        </Button>
      )}

      {showChangeWallet && (
        <Button
          onClick={onChangeWallet}
          variant="outline"
          aria-label="Change wallet or switch network"
        >
          Change wallet / network
        </Button>
      )}

      {showSupport && (
        <a
          href={supportUrl ?? SUPPORT_FALLBACK_URL}
          className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="Contact support"
        >
          Contact support
        </a>
      )}

      {showCancel && (
        <Button
          onClick={onCancel}
          variant="ghost"
          aria-label="Cancel and go back"
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

// ─── Category → icon / colour ─────────────────────────────────────────────────

const CATEGORY_META: Record<
  string,
  { icon: string; alertVariant: 'default' | 'destructive'; label: string }
> = {
  wallet_rejection:    { icon: '🚫', alertVariant: 'default',     label: 'Wallet declined' },
  timeout:             { icon: '⏱️', alertVariant: 'default',     label: 'Timed out' },
  network:             { icon: '🌐', alertVariant: 'destructive',  label: 'Network mismatch' },
  funds:               { icon: '💸', alertVariant: 'destructive',  label: 'Insufficient funds' },
  provider:            { icon: '⚠️', alertVariant: 'default',     label: 'Provider error' },
  confirmed_duplicate: { icon: '✅', alertVariant: 'default',     label: 'Already confirmed' },
  circuit_open:        { icon: '🔒', alertVariant: 'default',     label: 'Temporarily paused' },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * PaymentErrorDisplay
 *
 * Classifies `error` using the shared taxonomy, then renders:
 *  1. An accessible alert with the safe user message.
 *  2. An "amount is safe" reassurance when the error is retryable (funds untouched).
 *  3. Contextual action buttons based on suggestedAction.
 */
export function PaymentErrorDisplay({
  error,
  currentPaymentStatus,
  onRetry,
  onChangeWallet,
  onCancel,
  supportUrl,
}: PaymentErrorDisplayProps) {
  const classification = classifyPaymentError(error, currentPaymentStatus);
  const meta = CATEGORY_META[classification.category] ?? CATEGORY_META.provider;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
      data-testid="payment-error-display"
    >
      {/* Icon + heading */}
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden="true">
          {meta.icon}
        </span>
        <div className="flex-1">
          <h3 className="font-semibold text-gray-900" data-testid="error-category-label">
            {meta.label}
          </h3>

          {/* Safe user message — never shows internals */}
          <p
            className="mt-1 text-sm text-gray-600"
            data-testid="error-user-message"
          >
            {classification.userMessage}
          </p>
        </div>
      </div>

      {/* "Funds are safe" reassurance for retryable, non-terminal errors */}
      {classification.canRetry && !classification.isTerminal && (
        <p
          className="mt-3 text-xs text-gray-500 rounded-md bg-gray-50 border border-gray-200 px-3 py-2"
          data-testid="funds-safe-banner"
          role="note"
        >
          Your funds have <strong>not</strong> been charged. It is safe to retry.
        </p>
      )}

      {/* Submitted-status safety note */}
      {currentPaymentStatus === 'submitted' && (
        <p
          className="mt-3 text-xs text-yellow-700 rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2"
          data-testid="submitted-safety-note"
          role="note"
        >
          Your transaction was submitted to the Stellar network. Do{' '}
          <strong>not</strong> retry — we are polling for confirmation.
        </p>
      )}

      {/* Action buttons */}
      <ActionButtons
        classification={classification}
        onRetry={onRetry}
        onChangeWallet={onChangeWallet}
        onCancel={onCancel}
        supportUrl={supportUrl}
      />
    </div>
  );
}

export default PaymentErrorDisplay;
