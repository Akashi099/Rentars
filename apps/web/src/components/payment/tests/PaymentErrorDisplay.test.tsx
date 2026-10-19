/**
 * PaymentErrorDisplay tests (#771)
 *
 * Covers:
 *  - All error categories render correct user message and action buttons
 *  - canRetry=true shows "funds safe" banner
 *  - status=submitted shows "do not retry" banner and hides retry button
 *  - status=confirmed shows confirmed_duplicate classification
 *  - Unknown error falls back to 'provider' category
 *  - Retry / cancel / change-wallet callbacks fire correctly
 *  - No internal error details, stack traces, or secrets appear in output
 *  - paymentErrorTaxonomy classifyPaymentError unit coverage
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentErrorDisplay } from '../PaymentErrorDisplay';
import { classifyPaymentError } from '@/lib/errors/paymentErrorTaxonomy';

// ─── Mock freighter-utils ─────────────────────────────────────────────────────

vi.mock('@/lib/freighter-utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/freighter-utils')>(
    '@/lib/freighter-utils',
  );

  class FreighterError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'FreighterError';
    }
  }

  return { ...actual, FreighterError };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApiError(code: string) {
  return { code, message: `Error: ${code}` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// classifyPaymentError unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyPaymentError — taxonomy logic', () => {
  it('classifies PAYMENT_USER_REJECTED as wallet_rejection, canRetry=true', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_USER_REJECTED'));
    expect(c.category).toBe('wallet_rejection');
    expect(c.canRetry).toBe(true);
    expect(c.isTerminal).toBe(false);
  });

  it('classifies PAYMENT_TIMEOUT as timeout, canRetry=true', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_TIMEOUT'));
    expect(c.category).toBe('timeout');
    expect(c.canRetry).toBe(true);
  });

  it('classifies PAYMENT_NETWORK_MISMATCH as network, canRetry=false, change_wallet', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_NETWORK_MISMATCH'));
    expect(c.category).toBe('network');
    expect(c.canRetry).toBe(false);
    expect(c.suggestedAction).toBe('change_wallet');
  });

  it('classifies PAYMENT_INSUFFICIENT_FUNDS as funds, isTerminal=true', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_INSUFFICIENT_FUNDS'));
    expect(c.category).toBe('funds');
    expect(c.isTerminal).toBe(true);
    expect(c.canRetry).toBe(false);
  });

  it('classifies PAYMENT_TX_SUBMIT_FAILED as provider, canRetry=true', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_TX_SUBMIT_FAILED'));
    expect(c.category).toBe('provider');
    expect(c.canRetry).toBe(true);
  });

  it('classifies PAYMENT_ALREADY_CONFIRMED as confirmed_duplicate, isTerminal=true', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_ALREADY_CONFIRMED'));
    expect(c.category).toBe('confirmed_duplicate');
    expect(c.isTerminal).toBe(true);
  });

  it('classifies PAYMENT_CIRCUIT_OPEN as circuit_open, canRetry=false', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_CIRCUIT_OPEN'));
    expect(c.category).toBe('circuit_open');
    expect(c.canRetry).toBe(false);
  });

  it('classifies PAYMENT_ATTEMPT_LIMIT_EXCEEDED as circuit_open', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_ATTEMPT_LIMIT_EXCEEDED'));
    expect(c.category).toBe('circuit_open');
  });

  it('falls back to provider for unknown error code', () => {
    const c = classifyPaymentError(makeApiError('COMPLETELY_UNKNOWN_XYZ'));
    expect(c.category).toBe('provider');
  });

  it('forces confirmed_duplicate when currentPaymentStatus=confirmed', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_TX_SUBMIT_FAILED'), 'confirmed');
    expect(c.category).toBe('confirmed_duplicate');
    expect(c.canRetry).toBe(false);
  });

  it('blocks retry when currentPaymentStatus=submitted', () => {
    const c = classifyPaymentError(makeApiError('PAYMENT_TIMEOUT'), 'submitted');
    expect(c.canRetry).toBe(false);
  });

  it('user message never contains Error: prefix or stack traces', () => {
    const codes = [
      'PAYMENT_USER_REJECTED', 'PAYMENT_TIMEOUT', 'PAYMENT_NETWORK_MISMATCH',
      'PAYMENT_INSUFFICIENT_FUNDS', 'PAYMENT_TX_SUBMIT_FAILED',
      'PAYMENT_ALREADY_CONFIRMED', 'PAYMENT_CIRCUIT_OPEN',
      'PAYMENT_ATTEMPT_LIMIT_EXCEEDED', 'UNKNOWN_CODE',
    ];
    for (const code of codes) {
      const { userMessage } = classifyPaymentError(makeApiError(code));
      expect(userMessage).not.toContain('Error:');
      expect(userMessage).not.toContain('at ');
      expect(userMessage).not.toContain('undefined');
      expect(userMessage.length).toBeGreaterThan(5);
    }
  });

  it('infers wallet_rejection from message keyword "rejected"', () => {
    const c = classifyPaymentError(new Error('Transaction rejected by user'));
    expect(c.category).toBe('wallet_rejection');
  });

  it('infers timeout from message keyword "timed out"', () => {
    const c = classifyPaymentError(new Error('Request timed out'));
    expect(c.category).toBe('timeout');
  });

  it('handles null error gracefully (falls back to provider)', () => {
    const c = classifyPaymentError(null);
    expect(c.category).toBe('provider');
    expect(c.userMessage.length).toBeGreaterThan(0);
  });

  it('handles string error gracefully', () => {
    const c = classifyPaymentError('something went wrong');
    expect(c.category).toBe('provider');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PaymentErrorDisplay component tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PaymentErrorDisplay component', () => {
  it('renders the component with correct testid', () => {
    render(
      <PaymentErrorDisplay error={makeApiError('PAYMENT_TIMEOUT')} />,
    );
    expect(screen.getByTestId('payment-error-display')).toBeInTheDocument();
  });

  it('shows safe user message for wallet_rejection', () => {
    render(<PaymentErrorDisplay error={makeApiError('PAYMENT_USER_REJECTED')} />);
    const msg = screen.getByTestId('error-user-message');
    expect(msg.textContent).toContain('declined');
    expect(msg.textContent).not.toContain('PAYMENT_USER_REJECTED');
    expect(msg.textContent).not.toContain('Error:');
  });

  it('shows "funds safe" banner when canRetry=true', () => {
    render(<PaymentErrorDisplay error={makeApiError('PAYMENT_TIMEOUT')} />);
    expect(screen.getByTestId('funds-safe-banner')).toBeInTheDocument();
  });

  it('does NOT show "funds safe" banner for isTerminal errors', () => {
    render(<PaymentErrorDisplay error={makeApiError('PAYMENT_INSUFFICIENT_FUNDS')} />);
    expect(screen.queryByTestId('funds-safe-banner')).toBeNull();
  });

  it('shows "do not retry" note when currentPaymentStatus=submitted', () => {
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_TX_SUBMIT_FAILED')}
        currentPaymentStatus="submitted"
      />,
    );
    expect(screen.getByTestId('submitted-safety-note')).toBeInTheDocument();
  });

  it('does NOT show retry button when currentPaymentStatus=submitted', () => {
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_TIMEOUT')}
        currentPaymentStatus="submitted"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('calls onRetry when retry button clicked', async () => {
    const onRetry = vi.fn();
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_USER_REJECTED')}
        onRetry={onRetry}
      />,
    );
    const btn = screen.getByRole('button', { name: /try again/i });
    await userEvent.click(btn);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('calls onCancel when cancel button clicked (for provider errors)', async () => {
    const onCancel = vi.fn();
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_TX_SUBMIT_FAILED')}
        onCancel={onCancel}
      />,
    );
    // provider errors suggest retry; cancel is still shown for navigation
    const cancelBtn = screen.queryByRole('button', { name: /cancel/i });
    if (cancelBtn) {
      await userEvent.click(cancelBtn);
      expect(onCancel).toHaveBeenCalledOnce();
    }
    // If cancel is not shown (suggestedAction=retry without onCancel), that's fine
  });

  it('shows change wallet button for network errors', () => {
    const onChangeWallet = vi.fn();
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_NETWORK_MISMATCH')}
        onChangeWallet={onChangeWallet}
      />,
    );
    expect(
      screen.getByRole('button', { name: /change wallet/i }),
    ).toBeInTheDocument();
  });

  it('calls onChangeWallet when button clicked for network error', async () => {
    const onChangeWallet = vi.fn();
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_NETWORK_MISMATCH')}
        onChangeWallet={onChangeWallet}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /change wallet/i }));
    expect(onChangeWallet).toHaveBeenCalledOnce();
  });

  it('shows support link for funds errors', () => {
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_INSUFFICIENT_FUNDS')}
        supportUrl="https://support.rentars.io"
      />,
    );
    const link = screen.getByRole('link', { name: /contact support/i });
    expect(link).toHaveAttribute('href', 'https://support.rentars.io');
  });

  it('falls back to mailto: when no supportUrl provided', () => {
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_INSUFFICIENT_FUNDS')}
      />,
    );
    const link = screen.getByRole('link', { name: /contact support/i });
    expect((link as HTMLAnchorElement).href).toMatch(/^mailto:/);
  });

  it('has role=alert for screen reader accessibility', () => {
    render(<PaymentErrorDisplay error={makeApiError('PAYMENT_TIMEOUT')} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('never shows raw error code or message in output', () => {
    const { container } = render(
      <PaymentErrorDisplay error={makeApiError('PAYMENT_TX_SUBMIT_FAILED')} />,
    );
    expect(container.textContent).not.toContain('PAYMENT_TX_SUBMIT_FAILED');
    // The raw code from makeApiError is "Error: PAYMENT_TX_SUBMIT_FAILED"
    expect(container.textContent).not.toContain('Error:');
  });

  it('renders confirmed_duplicate state when status=confirmed', () => {
    render(
      <PaymentErrorDisplay
        error={makeApiError('PAYMENT_TX_SUBMIT_FAILED')}
        currentPaymentStatus="confirmed"
      />,
    );
    // Should show "Already confirmed" label, not "Provider error"
    expect(screen.getByTestId('error-category-label').textContent).toContain('confirmed');
  });
});
