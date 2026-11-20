'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { HCaptcha } from '@/components/auth/HCaptcha';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Same neutral outcome for every address, so the UI never reveals whether an account exists. */
const NEUTRAL_MESSAGE =
  'If an account with that email exists, we have sent a link to reset your password. The link expires in 60 minutes.';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captchaEnabled =
    process.env.NEXT_PUBLIC_HCAPTCHA_ENABLED !== 'false' && !!process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (captchaEnabled && !captchaToken) {
      setError('Please complete the CAPTCHA challenge.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/password-reset/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), captchaToken: captchaToken || undefined }),
      });
      // Only rate limiting and CAPTCHA failures are shown; every other outcome looks identical.
      if (res.status === 429) {
        setError('Too many requests. Please wait a few minutes and try again.');
        return;
      }
      setDone(true);
    } catch {
      setError('We could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      id="main-content"
      className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4"
    >
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-900 p-8 shadow-lg">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Forgot your password?</h1>

        {done ? (
          <p role="status" className="mt-4 text-gray-700 dark:text-gray-300">
            {NEUTRAL_MESSAGE}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            <p className="text-gray-600 dark:text-gray-400">
              Enter the email address for your account and we will send you a reset link.
            </p>

            <div>
              <label htmlFor="forgot-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email address
              </label>
              <input
                id="forgot-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-describedby={error ? 'forgot-error' : undefined}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-white"
              />
            </div>

            {captchaEnabled && <HCaptcha onVerify={setCaptchaToken} onExpire={() => setCaptchaToken('')} />}

            {error && (
              <p id="forgot-error" role="alert" className="text-sm text-red-700 dark:text-red-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-400">
          <Link href="/login" className="font-medium text-blue-600 hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
