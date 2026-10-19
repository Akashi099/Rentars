'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@/validations/auth.schema';
import { useState, useCallback } from 'react';
import { Mail, Lock, Loader } from 'lucide-react';
import { HCaptcha } from './HCaptcha';
import { useTranslations } from '@/lib/i18n/useTranslations';
import { FormInput, FormErrorSummary } from '@/components/ui/form-field';
import { useFormErrorFocus } from '@/hooks/useFormErrorFocus';

interface LoginFormProps {
  onSubmit: (data: LoginInput & { captchaToken: string }) => Promise<void>;
  /** Server-returned error (e.g. invalid credentials). */
  serverError?: string | null;
}

export function LoginForm({ onSubmit, serverError }: LoginFormProps) {
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
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  });

  const onCaptchaVerify = useCallback((token: string) => {
    setCaptchaToken(token);
    setCaptchaError('');
  }, []);

  const onCaptchaExpire = useCallback(() => {
    setCaptchaToken('');
  }, []);

  /** Called by react-hook-form when client validation fails. */
  const onInvalid = () => focusFirstError('login-error-summary');

  const onSubmitHandler = async (data: LoginInput) => {
    if (captchaEnabled && !captchaToken) {
      setCaptchaError(t('captchaRequired'));
      focusFirstError('login-error-summary');
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
    errors.email && { fieldId: 'login-email', message: errors.email.message ?? 'Invalid email' },
    errors.password && { fieldId: 'login-password', message: errors.password.message ?? 'Invalid password' },
    captchaError && { fieldId: 'login-captcha', message: captchaError },
  ].filter(Boolean) as { fieldId: string; message: string }[];

  const hasFieldErrors = fieldErrors.length > 0;

  return (
    <form
      onSubmit={handleSubmit(onSubmitHandler, onInvalid)}
      className="space-y-4"
      noValidate
      aria-label={t('signIn')}
    >
      {/* Error summary — shown when field errors exist or server returns an error */}
      {(hasFieldErrors || serverError) && (
        <FormErrorSummary
          id="login-error-summary"
          // @ts-expect-error — summaryRef is RefObject<HTMLDivElement | null>; tabIndex makes div focusable
          ref={summaryRef}
          fieldErrors={hasFieldErrors ? fieldErrors : []}
          serverError={serverError}
        />
      )}

      {/* Email */}
      <FormInput
        id="login-email"
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
        id="login-password"
        label={t('passwordLabel')}
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        error={errors.password?.message}
        prefix={<Lock size={16} />}
        required
        {...register('password')}
      />

      {/* CAPTCHA */}
      <div>
        {/* Give the captcha widget a labelled region so AT users know what it is */}
        <div
          id="login-captcha"
          role="group"
          aria-labelledby="login-captcha-label"
        >
          <span id="login-captcha-label" className="sr-only">
            Security verification
          </span>
          <HCaptcha onVerify={onCaptchaVerify} onExpire={onCaptchaExpire} />
        </div>
        {captchaError && (
          <p
            id="login-captcha-error"
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
        {isSubmitting ? t('signingIn') : t('signIn')}
      </button>
    </form>
  );
}
