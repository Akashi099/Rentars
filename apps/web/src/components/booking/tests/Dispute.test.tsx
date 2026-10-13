import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DisputeButton from '../DisputeButton';
import DisputeModal from '../DisputeModal';
import type { Booking } from '@/types/booking';

const mockBookingConfirmed: Booking = {
  id: 'b1111111-2222-3333-4444-555555555555',
  property_id: 'prop-1',
  tenant_id: 'tenant-1',
  check_in: '2026-11-01',
  check_out: '2026-11-05',
  guest_count: 2,
  total_price: 500,
  status: 'Confirmed',
  created_at: '2026-10-01T00:00:00Z',
};

const mockBookingPending: Booking = {
  ...mockBookingConfirmed,
  status: 'Pending',
};

const mockBookingCompleted: Booking = {
  ...mockBookingConfirmed,
  status: 'Completed',
};

const mockBookingCancelled: Booking = {
  ...mockBookingConfirmed,
  status: 'Cancelled',
};

const mockBookingDisputed: Booking = {
  ...mockBookingConfirmed,
  status: 'Disputed',
};

describe('DisputeButton Component', () => {
  it('renders button for confirmed booking', () => {
    const handleClick = vi.fn();
    render(<DisputeButton booking={mockBookingConfirmed} onClick={handleClick} />);

    const button = screen.getByRole('button', { name: /open dispute/i });
    expect(button).toBeDefined();

    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('does not render button for pending booking', () => {
    const handleClick = vi.fn();
    const { container } = render(<DisputeButton booking={mockBookingPending} onClick={handleClick} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not render button for completed booking', () => {
    const { container } = render(<DisputeButton booking={mockBookingCompleted} onClick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not render button for cancelled booking', () => {
    const { container } = render(<DisputeButton booking={mockBookingCancelled} onClick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('does not render button for already disputed booking', () => {
    const { container } = render(<DisputeButton booking={mockBookingDisputed} onClick={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('honors disabled prop', () => {
    const handleClick = vi.fn();
    render(<DisputeButton booking={mockBookingConfirmed} onClick={handleClick} disabled />);
    const button = screen.getByRole('button', { name: /open dispute/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });
});

describe('DisputeModal Component', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onSubmit = vi.fn().mockResolvedValue(true);
  });

  it('does not render when isOpen is false', () => {
    const { container } = render(
      <DisputeModal
        isOpen={false}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal dialog when isOpen is true', () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText(/Report a Problem & Open Dispute/i)).toBeDefined();
    expect(screen.getByText(/Escrow Protection Active/i)).toBeDefined();
  });

  it('enforces required reason validation on empty submit', async () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /submit dispute/i });
    expect(submitBtn).toBeDisabled();
  });

  it('enforces minimum length validation on short reason submit', async () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /reason for dispute/i });
    fireEvent.change(textarea, { target: { value: 'Short' } });

    const submitBtn = screen.getByRole('button', { name: /submit dispute/i });
    fireEvent.click(submitBtn);

    expect(await screen.findByText(/at least 10 characters/i)).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits valid dispute reason and calls onSubmit', async () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /reason for dispute/i });
    fireEvent.change(textarea, { target: { value: 'Host was not present and door code was invalid.' } });

    const submitBtn = screen.getByRole('button', { name: /submit dispute/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith('Host was not present and door code was invalid.');
    });
  });

  it('shows loading indicator and prevents duplicate submissions while pending', async () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
        isSubmitting={true}
      />
    );

    expect(screen.getByText(/Submitting dispute.../i)).toBeDefined();
    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    expect(cancelBtn).toBeDisabled();
  });

  it('calls onClose when Cancel button is clicked', () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('handles escape key to close', () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('displays error banner when error prop is present', () => {
    render(
      <DisputeModal
        isOpen={true}
        onClose={onClose}
        onSubmit={onSubmit}
        bookingId={mockBookingConfirmed.id}
        error="Network error: server unreachable"
      />
    );

    expect(screen.getByText(/Network error: server unreachable/i)).toBeDefined();
  });
});
