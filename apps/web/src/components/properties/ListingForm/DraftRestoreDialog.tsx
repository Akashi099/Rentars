'use client';

import { useEffect, useRef, useState } from 'react';

interface DraftRestoreDialogProps {
  hasDraft: boolean;
  onResume: () => void;
  onDiscard: () => void;
  /** Called when the dialog is dismissed without an explicit action (backdrop
   *  click, Escape key). Draft is NOT removed in this case. */
  onDismiss?: () => void;
  isOpen?: boolean;
  /** What was saved, e.g. "Saved 2 h ago, on step 3 of 7 (Amenities)." */
  summary?: string;
}

export default function DraftRestoreDialog({
  hasDraft,
  onResume,
  onDiscard,
  onDismiss,
  isOpen = true,
  summary,
}: DraftRestoreDialogProps) {
  const [mounted, setMounted] = useState(false);
  const discardButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Handle Escape key — dismiss only, do NOT discard the draft
  useEffect(() => {
    if (!mounted || !hasDraft || !isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mounted, hasDraft, isOpen, onDismiss]);

  if (!mounted || !hasDraft || !isOpen) {
    return null;
  }

  const handleBackdropClick = () => {
    // Backdrop click dismisses the dialog without discarding the draft
    onDismiss?.();
  };

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-dialog-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          padding: '24px',
          maxWidth: '400px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)',
        }}
      >
        <h2
          id="draft-dialog-title"
          style={{ fontSize: '18px', fontWeight: '600', marginBottom: '16px', marginTop: 0 }}
        >
          Resume Draft?
        </h2>
        <p style={{ marginBottom: '24px', color: '#666', margin: '0 0 24px 0' }}>
          We found a saved draft of your listing. Would you like to resume editing it?
        </p>
        {summary && (
          <p data-testid="draft-summary" style={{ margin: '0 0 16px 0', fontSize: '14px', color: '#333' }}>
            {summary}
          </p>
        )}
        <p style={{ margin: '0 0 16px 0', fontSize: '12px', color: '#666' }}>
          Photos are not saved with drafts. You will need to add them again.
        </p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button
            ref={discardButtonRef}
            onClick={onDiscard}
            style={{
              padding: '8px 16px',
              border: '1px solid #ccc',
              borderRadius: '4px',
              backgroundColor: 'white',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Discard
          </button>
          <button
            onClick={onResume}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: '#2563eb',
              color: 'white',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  );
}
