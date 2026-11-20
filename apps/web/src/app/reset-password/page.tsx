'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getPasswordPolicyErrors } from '@/lib/auth/password-policy';
import { classifyResetResponse, type Outcome } from '@/lib/auth/reset-state';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function ResetPasswordContent() {
  const searchParams = useSearchParams();
  // The token is read once from the URL, then removed from the address bar and history.
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  useEffect(() => {
    const fromUrl = searchParams.get('token');
    if (fromUrl) {
      setToken(fromUrl);
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [searchParams]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) return;

    const errors = getPasswordPolicyErrors(password);
    if (password !== confirm) errors.push('Passwords do not match.');
    setFieldErrors(errors);
    if (errors.length > 0) return;

    setSubmitting(true);
    setOutcome({ kind: 'idle' });
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/password-reset/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      let code: string | undefined;
      try {
        const body = (await res.json()) as { error?: { code?: string } };
        code = body?.error?.code;
      } catch {
        code = undefined;
      }
      const result = classifyResetResponse(res.status, code);
      setOutcome(result);
      if (result.kind === 'success') {
        setToken(null);
        setPassword('');
        setConfirm('');
      }
    } catch {
      setOutcome({ kind: 'error', message: 'We could not reach the server. Please try again.' });
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Set a new password</h1>

        {outcome.kind === 'success' && (
          <div className="mt-4" role="status">
            <p className="text-gray-700 dark:text-gray-300">
              Your password has been updated. All other devices have been signed out.
            </p>
            <Link href="/login" className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700">
              Sign in
            </Link>
          </div>
        )}

        {outcome.kind === 'invalid' && (
          <div className="mt-4" role="alert">
            <p className="text-gray-700 dark:text-gray-300">
              This reset link is invalid, has expired, or has already been used.
            </p>
            <Link href="/forgot-password" className="mt-6 inline-block font-medium text-blue-600 hover:underline">
              Request a new link
            </Link>
          </div>
        )}

        {outcome.kind !== 'success' && outcome.kind !== 'invalid' && !token && (
          <div className="mt-4" role="alert">
            <p className="text-gray-700 dark:text-gray-300">
              This page needs a reset link from your email. Open the link we sent you, or request a new one.
            </p>
            <Link href="/forgot-password" className="mt-6 inline-block font-medium text-blue-600 hover:underline">
              Request a new link
            </Link>
          </div>
        )}

        {token && outcome.kind !== 'success' && outcome.kind !== 'invalid' && (
          <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
            <div>
              <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="password-requirements"
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-white"
              />
              <p id="password-requirements" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                At least 12 characters, with uppercase, lowercase, a number and a special character.
              </p>
            </div>

            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-white"
              />
            </div>

            {fieldErrors.length > 0 && (
              <ul role="alert" className="list-disc pl-5 text-sm text-red-700 dark:text-red-300">
                {fieldErrors.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            )}
            {outcome.kind === 'error' && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {outcome.message}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center">Loading…</p>}>
      <ResetPasswordContent />
    </Suspense>
  );
}
