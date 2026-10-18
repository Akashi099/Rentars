'use client';

/**
 * Accessible form-field primitives.
 *
 * These components enforce the WCAG 2.1 AA requirements for form controls:
 *  - Every input/select/textarea has a programmatically associated <label>
 *    via a matching htmlFor / id pair.
 *  - When a field is invalid, aria-invalid="true" is set on the control.
 *  - The error message is given a stable id and linked to the control via
 *    aria-describedby so screen readers announce it when the field is focused.
 *  - The error container carries role="alert" so late-appearing errors are
 *    announced without requiring a focus change.
 *  - A hint (descriptive text shown below a label) can also be linked via
 *    aria-describedby alongside the error id.
 *
 * Usage:
 *
 *  <FormField
 *    id="listing-title"
 *    label="Property title"
 *    error={errors.title}
 *    required
 *  >
 *    <input
 *      id="listing-title"
 *      type="text"
 *      aria-invalid={!!errors.title}
 *      aria-describedby={buildDescribedBy('listing-title', !!errors.title, false)}
 *      ...
 *    />
 *  </FormField>
 *
 * Or use the convenience wrappers FormInput, FormTextarea, FormSelect which
 * wire everything automatically.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

// ─── buildDescribedBy ─────────────────────────────────────────────────────────

/**
 * Build the space-separated aria-describedby value for a field.
 *
 * Includes the error id when `hasError` is true and the hint id when
 * `hasHint` is true. Returns undefined when there is nothing to describe,
 * which prevents an empty aria-describedby attribute.
 */
export function buildDescribedBy(
  fieldId: string,
  hasError: boolean,
  hasHint: boolean,
): string | undefined {
  const parts: string[] = [];
  if (hasHint) parts.push(`${fieldId}-hint`);
  if (hasError) parts.push(`${fieldId}-error`);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

// ─── FormFieldContext ──────────────────────────────────────────────────────────

interface FormFieldContextValue {
  fieldId: string;
  hasError: boolean;
  hasHint: boolean;
}

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

export function useFormFieldContext(): FormFieldContextValue | null {
  return React.useContext(FormFieldContext);
}

// ─── FormField ────────────────────────────────────────────────────────────────

export interface FormFieldProps {
  /** Matches the id on the child control. */
  id: string;
  label: React.ReactNode;
  /** Optional descriptive text shown below the label. Linked via aria-describedby. */
  hint?: React.ReactNode;
  /** Error message. When present, the field is marked invalid and the message announced. */
  error?: string | null;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Container that provides a label, optional hint, and accessible error message
 * for any form control passed as children.
 *
 * The children are responsible for setting aria-invalid and aria-describedby
 * using the buildDescribedBy helper or by consuming FormFieldContext, but the
 * convenience wrappers (FormInput, FormTextarea, FormSelect) do this
 * automatically.
 */
export function FormField({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const hasError = !!error;
  const hasHint = !!hint;

  return (
    <FormFieldContext.Provider value={{ fieldId: id, hasError, hasHint }}>
      <div className={cn('space-y-1', className)}>
        <label
          htmlFor={id}
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          {label}
          {required && (
            <span aria-hidden="true" className="ml-1 text-red-500">
              *
            </span>
          )}
          {required && (
            <span className="sr-only">(required)</span>
          )}
        </label>

        {hint && (
          <p id={`${id}-hint`} className="text-xs text-gray-500 dark:text-gray-400">
            {hint}
          </p>
        )}

        {children}

        {/* Error — role="alert" announces late-appearing messages without focus */}
        {hasError && (
          <p
            id={`${id}-error`}
            role="alert"
            aria-live="polite"
            className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400"
          >
            {/* Decorative icon keeps the visual cue but is hidden from AT */}
            <span aria-hidden="true">⚠</span>
            {error}
          </p>
        )}
      </div>
    </FormFieldContext.Provider>
  );
}

// ─── Base input styles ────────────────────────────────────────────────────────

export const inputBaseClass =
  'w-full rounded-lg border px-3 py-2 text-sm text-gray-900 bg-white ' +
  'dark:text-gray-100 dark:bg-gray-800 ' +
  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ' +
  'disabled:cursor-not-allowed disabled:opacity-50 ' +
  'placeholder:text-gray-400 dark:placeholder:text-gray-500';

export const inputNormalBorder = 'border-gray-300 dark:border-gray-600';
export const inputErrorBorder  = 'border-red-500 dark:border-red-400 bg-red-50 dark:bg-red-950/30';

// ─── FormInput ────────────────────────────────────────────────────────────────

export interface FormInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  /** Prepend node (icon, currency symbol, …). Adds left padding to the input. */
  prefix?: React.ReactNode;
  /** Append node (unit, button, …). Adds right padding to the input. */
  suffix?: React.ReactNode;
}

/**
 * Single-line input with a label, optional hint, and accessible error.
 * All ARIA wiring is automatic.
 */
export const FormInput = React.forwardRef<HTMLInputElement, FormInputProps>(
  ({ id, label, hint, error, prefix, suffix, className, required, ...props }, ref) => {
    const hasError = !!error;
    const hasHint = !!hint;
    const describedBy = buildDescribedBy(id, hasError, hasHint);

    return (
      <FormField id={id} label={label} hint={hint} error={error} required={required}>
        <div className={cn('relative flex items-center', prefix && 'has-prefix', suffix && 'has-suffix')}>
          {prefix && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 flex items-center text-gray-400"
            >
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={id}
            required={required}
            aria-required={required}
            aria-invalid={hasError || undefined}
            aria-describedby={describedBy}
            className={cn(
              inputBaseClass,
              hasError ? inputErrorBorder : inputNormalBorder,
              prefix && 'pl-9',
              suffix && 'pr-9',
              className,
            )}
            {...props}
          />
          {suffix && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3 flex items-center text-gray-400"
            >
              {suffix}
            </span>
          )}
        </div>
      </FormField>
    );
  },
);
FormInput.displayName = 'FormInput';

// ─── FormTextarea ─────────────────────────────────────────────────────────────

export interface FormTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  /** Show a character counter. Requires maxLength. */
  showCount?: boolean;
}

export const FormTextarea = React.forwardRef<HTMLTextAreaElement, FormTextareaProps>(
  ({ id, label, hint, error, showCount, className, required, maxLength, value, ...props }, ref) => {
    const hasError = !!error;
    const hasHint = !!hint;
    const describedBy = buildDescribedBy(id, hasError, hasHint);
    const charCount = typeof value === 'string' ? value.length : 0;

    return (
      <FormField id={id} label={label} hint={hint} error={error} required={required}>
        <textarea
          ref={ref}
          id={id}
          required={required}
          aria-required={required}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          maxLength={maxLength}
          value={value}
          className={cn(
            inputBaseClass,
            'resize-none',
            hasError ? inputErrorBorder : inputNormalBorder,
            className,
          )}
          {...props}
        />
        {showCount && maxLength !== undefined && (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-right mt-0.5" aria-live="polite">
            {charCount} / {maxLength}
          </p>
        )}
      </FormField>
    );
  },
);
FormTextarea.displayName = 'FormTextarea';

// ─── FormSelect ───────────────────────────────────────────────────────────────

export interface FormSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  /** Placeholder option shown when no value is selected. */
  placeholder?: string;
}

export const FormSelect = React.forwardRef<HTMLSelectElement, FormSelectProps>(
  ({ id, label, hint, error, placeholder, className, required, children, ...props }, ref) => {
    const hasError = !!error;
    const hasHint = !!hint;
    const describedBy = buildDescribedBy(id, hasError, hasHint);

    return (
      <FormField id={id} label={label} hint={hint} error={error} required={required}>
        <select
          ref={ref}
          id={id}
          required={required}
          aria-required={required}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          className={cn(
            inputBaseClass,
            hasError ? inputErrorBorder : inputNormalBorder,
            className,
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {children}
        </select>
      </FormField>
    );
  },
);
FormSelect.displayName = 'FormSelect';

// ─── FormErrorSummary ─────────────────────────────────────────────────────────

/**
 * Submission-level error summary rendered at the top of a form.
 *
 * When a submit attempt fails:
 *  - Renders a box listing all field errors (or a single server error).
 *  - Has role="alert" so screen readers announce it without focus change.
 *  - Each item is a link that moves focus to the relevant field, satisfying
 *    the WCAG 2.4.3 Focus Order and 3.3.1 Error Identification criteria.
 *
 * Use with useFormErrorFocus to also move focus to the summary on submit.
 */
export interface FieldErrorSummaryItem {
  /** Matches the id of the input to focus when the link is activated. */
  fieldId: string;
  message: string;
}

export interface FormErrorSummaryProps {
  /** Id applied to the summary container. Use this as the focus target. */
  id?: string;
  /** Field-level errors derived from react-hook-form formState.errors. */
  fieldErrors?: FieldErrorSummaryItem[];
  /** Top-level server/submit error (e.g. "Incorrect email or password"). */
  serverError?: string | null;
  className?: string;
}

export function FormErrorSummary({
  id = 'form-error-summary',
  fieldErrors = [],
  serverError,
  className,
}: FormErrorSummaryProps) {
  const hasErrors = fieldErrors.length > 0 || !!serverError;
  if (!hasErrors) return null;

  return (
    <div
      id={id}
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      tabIndex={-1}
      className={cn(
        'rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-700 p-4 space-y-2',
        className,
      )}
    >
      <p className="text-sm font-semibold text-red-800 dark:text-red-300">
        {fieldErrors.length > 1
          ? `Please fix ${fieldErrors.length} errors before continuing.`
          : 'Please fix the error below before continuing.'}
      </p>

      {/* Server / submission error */}
      {serverError && (
        <p className="text-sm text-red-700 dark:text-red-400">{serverError}</p>
      )}

      {/* Per-field links */}
      {fieldErrors.length > 0 && (
        <ul className="list-disc list-inside space-y-1">
          {fieldErrors.map(({ fieldId, message }) => (
            <li key={fieldId} className="text-sm text-red-700 dark:text-red-400">
              <a
                href={`#${fieldId}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(fieldId);
                  if (el) el.focus();
                }}
                className="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-500 rounded"
              >
                {message}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
