'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';

export interface DisputeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<boolean | void>;
  bookingId: string;
  isSubmitting?: boolean;
  error?: string | null;
  onClearError?: () => void;
}

const MIN_REASON_LENGTH = 10;

/**
 * DisputeModal provides an accessible, validated form for raising a dispute on an active booking.
 * It enforces required reason input, prevents duplicate submissions, traps keyboard interactions,
 * and explains the escrow resolution process.
 */
export default function DisputeModal({
  isOpen,
  onClose,
  onSubmit,
  bookingId,
  isSubmitting = false,
  error = null,
  onClearError,
}: DisputeModalProps) {
  const [reason, setReason] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus textarea when modal opens, reset state
  useEffect(() => {
    if (isOpen) {
      setReason('');
      setValidationError(null);
      setIsSuccess(false);
      onClearError?.();
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Handle escape key to dismiss
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || isSubmitting) return;
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const trimmed = reason.trim();
    if (!trimmed) {
      setValidationError('Please provide a reason for opening this dispute.');
      textareaRef.current?.focus();
      return;
    }

    if (trimmed.length < MIN_REASON_LENGTH) {
      setValidationError(`Please describe the issue in more detail (at least ${MIN_REASON_LENGTH} characters).`);
      textareaRef.current?.focus();
      return;
    }

    setValidationError(null);
    try {
      const res = await onSubmit(trimmed);
      if (res !== false) {
        setIsSuccess(true);
        setTimeout(() => {
          onClose();
        }, 1500);
      }
    } catch {
      // Handled via external error prop
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) {
          onClose();
        }
      }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dispute-title"
        aria-describedby="dispute-desc"
        className="w-full max-w-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800
          rounded-xl shadow-2xl p-6 space-y-5 animate-in fade-in-0 zoom-in-95 duration-150"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400">
              <AlertTriangle size={20} aria-hidden="true" />
            </div>
            <div>
              <h2 id="dispute-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Report a Problem & Open Dispute
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Booking ID: {bookingId.slice(0, 8)}...
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close dispute modal"
            className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200
              hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Informational Notice */}
        <div
          id="dispute-desc"
          className="p-3.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200
            dark:border-amber-800/60 text-xs text-amber-900 dark:text-amber-300 space-y-1"
        >
          <p className="font-medium">Escrow Protection Active</p>
          <p className="leading-relaxed">
            Opening a dispute will pause automatic payout. Escrow funds will remain safely locked
            until platform administrators review the evidence and issue a resolution.
          </p>
        </div>

        {/* Success confirmation */}
        {isSuccess ? (
          <div
            role="status"
            className="p-4 rounded-lg bg-green-50 dark:bg-green-950/40 border border-green-200
              dark:border-green-800 text-green-800 dark:text-green-200 flex items-center gap-3 text-sm font-medium"
          >
            <CheckCircle2 size={18} className="text-green-600 dark:text-green-400 shrink-0" aria-hidden="true" />
            <span>Dispute opened successfully. The booking has transitioned to Disputed status.</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Server Error banner */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/40
                  border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs"
              >
                <AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span className="flex-1">{error}</span>
                {onClearError && (
                  <button
                    type="button"
                    onClick={onClearError}
                    aria-label="Dismiss error"
                    className="text-red-500 hover:text-red-700 font-bold"
                  >
                    ×
                  </button>
                )}
              </div>
            )}

            {/* Client Validation Error */}
            {validationError && (
              <div
                role="alert"
                className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/40
                  border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs"
              >
                <AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
                <span className="flex-1">{validationError}</span>
              </div>
            )}

            {/* Reason Field */}
            <div className="space-y-1.5">
              <label
                htmlFor="dispute-reason-input"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Reason for dispute <span className="text-red-500">*</span>
              </label>
              <textarea
                id="dispute-reason-input"
                ref={textareaRef}
                rows={4}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                disabled={isSubmitting}
                placeholder="Please describe why you are reporting this booking (e.g. condition issues, host no-show, amenities mismatch)..."
                aria-required="true"
                aria-invalid={!!validationError}
                className="w-full border border-gray-300 dark:border-gray-700 rounded-lg p-3 text-sm
                  bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400
                  focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none disabled:opacity-50"
              />
              <div className="flex justify-between text-[11px] text-gray-500 dark:text-gray-400">
                <span>Minimum {MIN_REASON_LENGTH} characters required</span>
                <span>{reason.trim().length} characters</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2.5 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm
                  font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800
                  disabled:opacity-50 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !reason.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white
                  text-sm font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed
                  transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                    <span>Submitting dispute...</span>
                  </>
                ) : (
                  <span>Submit dispute</span>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
