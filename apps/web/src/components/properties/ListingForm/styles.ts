/**
 * Shared Tailwind class strings for the multi-step listing form.
 *
 * All inputs, textareas, and selects accept an optional `data-invalid`
 * variant — apply `formStyles.inputError` instead of `formStyles.input`
 * when a field has a validation error so the border color communicates
 * state visually in addition to the accessible error message.
 */
export const formStyles = {
  container: 'w-full max-w-2xl mx-auto px-4 sm:px-0',
  section: 'bg-white p-4 sm:p-6 lg:p-8 rounded-lg border',
  heading: 'text-xl sm:text-2xl font-bold mb-4 sm:mb-6',
  formGroup: 'mb-4 sm:mb-6',
  label: 'block text-sm font-semibold text-gray-700 mb-2',
  input:
    'w-full min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-focus focus:border-focus',
  inputError:
    'w-full min-w-0 px-4 py-2 border border-error rounded-lg focus:outline-none focus:ring-2 focus:ring-error focus:border-error bg-error-subtle',
  textarea:
    'w-full min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-focus focus:border-focus resize-none',
  textareaError:
    'w-full min-w-0 px-4 py-2 border border-error rounded-lg focus:outline-none focus:ring-2 focus:ring-error focus:border-error bg-error-subtle resize-none',
  select:
    'w-full min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-focus focus:border-focus',
  selectError:
    'w-full min-w-0 px-4 py-2 border border-error rounded-lg focus:outline-none focus:ring-2 focus:ring-error focus:border-error bg-error-subtle',
  checkbox:
    'w-4 h-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-focus',
  button:
    'px-4 sm:px-6 py-2 rounded-lg font-semibold transition min-h-[44px] min-w-[44px] whitespace-normal break-words',
  buttonPrimary: 'bg-blue-600 text-white hover:bg-blue-700',
  buttonSecondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
  /** Error message paragraph — must always have a matching `id` and `role="alert"`. */
  error: 'text-error text-sm mt-1',
  stepIndicator: 'flex gap-2 mb-6 sm:mb-8',
  step: 'flex-1 min-w-0 h-2 rounded-full transition',
  stepActive: 'bg-blue-600',
  stepInactive: 'bg-gray-300',
};
