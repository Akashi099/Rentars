'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface ModalProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  closeButton?: React.ReactNode;
  /**
   * Optional id of the element that labels the dialog. When omitted, the
   * modal generates its own id and exposes it via the ModalContext so that
   * ModalHeader can reference it with aria-labelledby.
   */
  labelledBy?: string;
  /**
   * Optional id of the element that describes the dialog (e.g. helper text).
   */
  describedBy?: string;
  /**
   * Optional ref to the element that should receive focus when the modal
   * opens. Falls back to the first focusable element, then the dialog itself.
   */
  initialFocusRef?: React.RefObject<HTMLElement>;
  /**
   * Called when the user requests to close the modal (Escape, backdrop click,
   * or close button). Defaults to calling onOpenChange(false).
   */
  onCancel?: () => void;
}

interface ModalContextValue {
  titleId: string;
  descriptionId: string;
}

const ModalContext = React.createContext<ModalContextValue | null>(null);

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  return Array.from(nodes).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // Skip elements that are not rendered (offsetParent is null for
    // display:none, but fixed-position elements also report null, so we
    // additionally check visibility via getClientRects).
    if (el.getClientRects().length === 0) return false;
    return true;
  });
}

export const Modal = React.forwardRef<HTMLDivElement, ModalProps>(
  (
    {
      open,
      onOpenChange,
      title,
      children,
      closeButton,
      labelledBy,
      describedBy,
      initialFocusRef,
      onCancel,
      className,
      ...props
    },
    ref
  ) => {
    const dialogRef = React.useRef<HTMLDivElement>(null);
    const previousActiveElement = React.useRef<HTMLElement | null>(null);
    const generatedId = React.useId();
    const titleId = labelledBy ?? `modal-title-${generatedId}`;
    const descriptionId = describedBy ?? `modal-description-${generatedId}`;

    // Merge forwarded ref with internal ref so consumers can still access
    // the dialog element while we manage focus internally.
    const setDialogRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        dialogRef.current = node;
        if (typeof ref === 'function') {
          ref(node);
        } else if (ref) {
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }
      },
      [ref]
    );

    const requestClose = React.useCallback(() => {
      if (onCancel) {
        onCancel();
      } else {
        onOpenChange(false);
      }
    }, [onCancel, onOpenChange]);

    // Capture the invoking element when the modal opens and restore focus
    // when it closes. This runs in a layout effect so the trigger is captured
    // before any child effects move focus.
    React.useLayoutEffect(() => {
      if (!open) return;
      previousActiveElement.current = document.activeElement as HTMLElement | null;
      return () => {
        const trigger = previousActiveElement.current;
        previousActiveElement.current = null;
        if (trigger && trigger.isConnected) {
          trigger.focus();
        }
      };
    }, [open]);

    // Focus management: move focus into the dialog on open and trap Tab
    // within the dialog. Focusable elements are queried on each keydown so
    // dynamically added controls (e.g. validation errors, new steps) are
    // included in the trap.
    React.useEffect(() => {
      if (!open) return;

      const dialogElement = dialogRef.current;
      if (!dialogElement) return;

      // Ensure the dialog itself is focusable as a fallback target.
      if (!dialogElement.hasAttribute('tabindex')) {
        dialogElement.setAttribute('tabindex', '-1');
      }

      const focusInitial = () => {
        const target =
          initialFocusRef?.current ??
          getFocusableElements(dialogElement)[0] ??
          dialogElement;
        target.focus();
      };

      // Defer focus to the next frame so children have mounted.
      const raf = window.requestAnimationFrame(focusInitial);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          requestClose();
          return;
        }

        if (e.key !== 'Tab') return;

        const focusable = getFocusableElements(dialogElement);
        if (focusable.length === 0) {
          e.preventDefault();
          dialogElement.focus();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        // If focus has escaped the dialog, pull it back in.
        if (!active || !dialogElement.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }

        if (e.shiftKey) {
          if (active === first || active === dialogElement) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          e.preventDefault();
          first.focus();
        }
      };

      // Listen on the document so focus cannot escape behind the overlay
      // even if a child stops propagation on the dialog element.
      document.addEventListener('keydown', handleKeyDown, true);

      // Guard against focus moving outside the dialog (e.g. programmatic
      // focus or mouse clicks on the backdrop).
      const handleFocusIn = (e: FocusEvent) => {
        const target = e.target as Node | null;
        if (target && !dialogElement.contains(target)) {
          const focusable = getFocusableElements(dialogElement);
          (focusable[0] ?? dialogElement).focus();
        }
      };
      document.addEventListener('focusin', handleFocusIn, true);

      // Prevent background scroll while the modal is open.
      const body = document.body;
      const originalOverflow = body.style.overflow;
      body.style.overflow = 'hidden';

      return () => {
        window.cancelAnimationFrame(raf);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('focusin', handleFocusIn, true);
        body.style.overflow = originalOverflow;
      };
    }, [open, requestClose, initialFocusRef]);

    if (!open) return null;

    return (
      <ModalContext.Provider value={{ titleId, descriptionId }}>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40"
          onClick={requestClose}
          role="presentation"
          aria-hidden="true"
        />

        {/* Modal Dialog */}
        <div
          ref={setDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          className={cn(
            'fixed inset-0 z-50 flex items-center justify-center p-4',
            className
          )}
          {...props}
        >
          <div className="bg-white rounded-lg shadow-lg max-w-md w-full max-h-[90vh] overflow-y-auto">
            {children}
          </div>
        </div>
      </ModalContext.Provider>
    );
  }
);

Modal.displayName = 'Modal';

interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  onClose?: () => void;
}

export const ModalHeader = React.forwardRef<HTMLDivElement, ModalHeaderProps>(
  ({ title, onClose, className, ...props }, ref) => {
    const context = React.useContext(ModalContext);
    const titleId = context?.titleId ?? 'modal-title';
    return (
      <div
        ref={ref}
        className={cn('flex items-center justify-between p-6 border-b', className)}
        {...props}
      >
        <h2 id={titleId} className="text-lg font-semibold text-gray-900">
          {title}
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition p-1"
            aria-label="Close modal"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>
    );
  }
);

ModalHeader.displayName = 'ModalHeader';

interface ModalContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ModalContent = React.forwardRef<HTMLDivElement, ModalContentProps>(
  ({ className, ...props }, ref) => {
    const context = React.useContext(ModalContext);
    return (
      <div
        ref={ref}
        id={context?.descriptionId}
        className={cn('p-6 space-y-4', className)}
        {...props}
      />
    );
  }
);

ModalContent.displayName = 'ModalContent';

interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ModalFooter = React.forwardRef<HTMLDivElement, ModalFooterProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('flex gap-3 p-6 border-t', className)}
      {...props}
    />
  )
);

ModalFooter.displayName = 'ModalFooter';
