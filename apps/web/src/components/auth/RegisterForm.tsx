'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema, type RegisterInput } from '@/validations/auth.schema';
import { useState, useCallback } from 'react';
import { User, Mail, Lock, Loader } from 'lucide-react';
import { HCaptcha } from './HCaptcha';
import { useTranslations } from '@/lib/i18n/useTranslations';
import { FormInput, FormErrorSummary } from '@/components/ui/form-field';
import { useFormErrorFocus } from '@/hooks/useFormErrorFocus';

interface RegisterFormProps {
  onSubmit: (data: RegisterInput & { captchaToken: string }) => Promise<void>;
  /** Server-returned error (e.g. email already in use). */
  serverError?: string | null;
}

export function RegisterForm({ onSubmit, serverError }: RegisterFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string>('');
  const [captchaError, setCaptchaError] = useState<string>('');
  const t = useTranslations('auth');
  const { summaryRef, focusFirstError } = useFormErrorFocus();

  const captchaEnabled =
    process.env.NEXT_PUBLIC_HCAPTCHA_ENABLED !== 'false' &&
    !!process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
  });

  const onCaptchaVerify = useCallback((token: string) => {
    setCaptchaToken(token);
    setCaptchaError('');
  }, []);

  const onCaptchaExpire = useCallback(() => {
    setCaptchaToken('');
  }, []);

  /** Called by react-hook-form when client validation fails. */
  const onInvalid = () => focusFirstError('register-error-summary');

  const onSubmitHandler = async (data: RegisterInput) => {
    if (captchaEnabled && !captchaToken) {
      setCaptchaError(t('captchaRequired'));
      focusFirstError('register-error-summary');
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({ ...data, captchaToken });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Build field-error list for the summary
  const fieldErrors = [
    errors.name && { fieldId: 'register-name', message: errors.name.message ?? 'Invalid name' },
    errors.email && { fieldId: 'register-email', message: errors.email.message ?? 'Invalid email' },
    errors.password && { fieldId: 'register-password', message: errors.password.message ?? 'Invalid password' },
    errors.confirmPassword && { fieldId: 'register-confirm-password', message: errors.confirmPassword.message ?? 'Passwords do not match' },
    captchaError && { fieldId: 'register-captcha', message: captchaError },
  ].filter(Boolean) as { fieldId: string; message: string }[];

  const hasFieldErrors = fieldErrors.length > 0;

  return (
    <form
      onSubmit={handleSubmit(onSubmitHandler, onInvalid)}
      className="space-y-4"
      noValidate
      aria-label={t('createAccount')}
    >
      {/* Error summary */}
      {(hasFieldErrors || serverError) && (
        <FormErrorSummary
          id="register-error-summary"
          // @ts-expect-error — summaryRef typing
          ref={summaryRef}
          fieldErrors={hasFieldErrors ? fieldErrors : []}
          serverError={serverError}
        />
      )}

      {/* Full Name */}
      <FormInput
        id="register-name"
        label={t('fullNameLabel')}
        type="text"
        autoComplete="name"
        placeholder="John Doe"
        error={errors.name?.message}
        prefix={<User size={16} />}
        required
        {...register('name')}
      />

      {/* Email */}
      <FormInput
        id="register-email"
        label={t('emailLabel')}
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        error={errors.email?.message}
        prefix={<Mail size={16} />}
        required
        {...register('email')}
      />

      {/* Password */}
      <FormInput
        id="register-password"
        label={t('passwordLabel')}
        type="password"
        autoComplete="new-password"
        placeholder="••••••••"
        error={errors.password?.message}
        prefix={<Lock size={16} />}
        required
        hint="Minimum 6 characters"
        {...register('password')}
      />

      {/* Confirm Password */}
      <FormInput
        id="register-confirm-password"
        label={t('confirmPasswordLabel')}
        type="password"
        autoComplete="new-password"
        placeholder="••••••••"
        error={errors.confirmPassword?.message}
        prefix={<Lock size={16} />}
        required
        {...register('confirmPassword')}
      />

      {/* CAPTCHA */}
      <div>
        <div
          id="register-captcha"
          role="group"
          aria-labelledby="register-captcha-label"
        >
          <span id="register-captcha-label" className="sr-only">
            Security verification
          </span>
          <HCaptcha onVerify={onCaptchaVerify} onExpire={onCaptchaExpire} />
        </div>
        {captchaError && (
          <p
            id="register-captcha-error"
            role="alert"
            aria-live="polite"
            className="text-red-600 dark:text-red-400 text-sm mt-1 flex items-center gap-1"
          >
            <span aria-hidden="true">⚠</span>
            {captchaError}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition font-medium flex items-center justify-center gap-2 min-h-[44px]"
        aria-busy={isSubmitting}
      >
        {isSubmitting && <Loader size={18} className="animate-spin" aria-hidden="true" />}
        {isSubmitting ? t('creatingAccount') : t('createAccount')}
      </button>
    </form>
  );
}
