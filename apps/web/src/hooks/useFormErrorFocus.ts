'use client';

/**
 * useFormErrorFocus
 *
 * Moves focus to a form's error summary container (or the first invalid
 * input) after a failed submission, fulfilling WCAG 2.4.3 (Focus Order)
 * and ensuring screen readers announce validation feedback.
 *
 * Works with react-hook-form, but the returned `focusFirstError` function
 * can also be called from any custom form submit handler.
 *
 * @example — react-hook-form
 *
 *   const { summaryRef, focusFirstError } = useFormErrorFocus();
 *
 *   const onInvalid = () => focusFirstError();
 *
 *   return (
 *     <form onSubmit={handleSubmit(onValid, onInvalid)}>
 *       <FormErrorSummary id="form-error-summary" ref={summaryRef} ... />
 *       ...
 *     </form>
 *   );
 *
 * @example — manual form
 *
 *   const { summaryRef, focusFirstError } = useFormErrorFocus();
 *
 *   const handleSubmit = (e) => {
 *     e.preventDefault();
 *     const errors = validate(...);
 *     if (errors) {
 *       setErrors(errors);
 *       focusFirstError('my-form-error-summary');
 *     }
 *   };
 */

import { useCallback, useRef } from 'react';

export interface UseFormErrorFocusReturn {
  /**
   * Ref to attach to the error-summary container element.
   * When the summary exists and has this ref, focusFirstError will
   * focus it directly.
   */
  summaryRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Move focus to the error summary, first form input with aria-invalid,
   * or an element matched by summaryId (searched in the document).
   *
   * Call this from the react-hook-form onInvalid callback or from your
   * own submit handler after setting error state.
   *
   * @param summaryId - Optional id of the summary element to focus.
   *                    Defaults to the summaryRef target.
   */
  focusFirstError: (summaryId?: string) => void;
}

export function useFormErrorFocus(): UseFormErrorFocusReturn {
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const focusFirstError = useCallback((summaryId?: string) => {
    // Small timeout lets React flush the DOM update (error state rendering)
    // before we attempt to focus — without this the element may not yet exist.
    setTimeout(() => {
      // 1. Try the attached ref
      if (summaryRef.current) {
        summaryRef.current.focus();
        return;
      }

      // 2. Try a named summary element
      if (summaryId) {
        const summary = document.getElementById(summaryId);
        if (summary) {
          summary.focus();
          return;
        }
      }

      // 3. Fall back to the first input with aria-invalid="true"
      const firstInvalid = document.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      if (firstInvalid) {
        firstInvalid.focus();
      }
    }, 50);
  }, []);

  return { summaryRef, focusFirstError };
}
