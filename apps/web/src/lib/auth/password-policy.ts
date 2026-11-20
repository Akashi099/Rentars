/**
 * Password policy shared by registration and reset forms.
 * Mirrors `registerSchema` / `confirmPasswordResetSchema` in
 * apps/backend/src/validators/auth.validator.ts. Keep the two in sync.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns human-readable policy failures. An empty array means the password is acceptable. */
export function getPasswordPolicyErrors(password: string): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (!/[A-Z]/.test(password)) errors.push('Password must contain an uppercase letter.');
  if (!/[a-z]/.test(password)) errors.push('Password must contain a lowercase letter.');
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number.');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Password must contain a special character.');
  return errors;
}
