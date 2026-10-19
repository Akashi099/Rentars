'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { normaliseStatus, TENANT_TRANSITIONS } from '@/types/booking';
import type { Booking } from '@/types/booking';

export interface DisputeButtonProps {
  booking: Booking;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * DisputeButton renders only when the booking state permits raising a dispute
 * (e.g. 'confirmed' bookings with active escrow where issues can be formally reported).
 */
export default function DisputeButton({
  booking,
  onClick,
  disabled = false,
  className = '',
}: DisputeButtonProps) {
  const status = normaliseStatus(booking.status);
  const allowed = TENANT_TRANSITIONS[status]?.includes('dispute') ?? false;

  // Ineligible booking states do not render the dispute trigger
  if (!allowed) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-label="Open dispute for booking"
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-400
        text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40
        text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900/40
        disabled:opacity-50 disabled:cursor-not-allowed transition
        focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${className}`}
    >
      <AlertTriangle size={15} aria-hidden="true" />
      <span>Open dispute</span>
    </button>
  );
}
