/**
 * Shared Tailwind class strings for the multi-step listing form.
 *
 * All inputs, textareas, and selects accept an optional `data-invalid`
 * variant — apply `formStyles.inputError` instead of `formStyles.input`
 * when a field has a validation error so the border color communicates
 * state visually in addition to the accessible error message.
 */
export const formStyles = {
  container: 'max-w-2xl mx-auto',
  section: 'bg-white p-8 rounded-lg border',
  heading: 'text-2xl font-bold mb-6',
  formGroup: 'mb-6',
  label: 'block text-sm font-semibold text-gray-700 mb-2',
  input:
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500',
  inputError:
    'w-full px-4 py-2 border border-red-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 bg-red-50',
  textarea:
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none',
  textareaError:
    'w-full px-4 py-2 border border-red-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 bg-red-50 resize-none',
  select:
    'w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500',
  selectError:
    'w-full px-4 py-2 border border-red-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 bg-red-50',
  checkbox: 'w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500',
  button: 'px-6 py-2 rounded-lg font-semibold transition min-h-[44px]',
  buttonPrimary: 'bg-blue-600 text-white hover:bg-blue-700',
  buttonSecondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300',
  /** Error message paragraph — must always have a matching `id` and `role="alert"`. */
  error: 'text-red-600 text-sm mt-1',
  stepIndicator: 'flex gap-2 mb-8',
  step: 'flex-1 h-2 rounded-full transition',
  stepActive: 'bg-blue-600',
  stepInactive: 'bg-gray-300',
};
