'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { classifyVerifyResponse, type VerifyState } from '@/lib/auth/verification-state';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<VerifyState>({ kind: 'verifying' });
  const [email, setEmail] = useState('');
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');

    // Strip the token from the address bar and history as soon as it is read,
    // so the single-use credential does not linger in browser history.
    if (typeof window !== 'undefined' && token) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!token) {
      setState({ kind: 'missing' });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        let code: string | undefined;
        try {
          const body = (await res.json()) as { error?: { code?: string } };
          code = body?.error?.code;
        } catch {
          code = undefined;
        }
        if (!cancelled) setState(classifyVerifyResponse(res.status, code));
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const onResend = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setResending(true);
    setResendMessage(null);
    try {
      await fetch(`${API_URL}/api/v1/auth/verify-email/resend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch {
      // The response is identical either way; network failures are shown below.
    } finally {
      setResending(false);
      setResendMessage('If an unverified account exists for that address, a new verification link has been sent.');
    }
  };

  const resendForm = (
    <form onSubmit={onResend} className="mt-6 space-y-3" aria-label="Request a new verification link">
      <label htmlFor="resend-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
        Email address
      </label>
      <input
        id="resend-email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-white"
      />
      <button
        type="submit"
        disabled={resending}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {resending ? 'Sending…' : 'Send a new link'}
      </button>
      {resendMessage && (
        <p role="status" className="text-sm text-gray-600 dark:text-gray-400">
          {resendMessage}
        </p>
      )}
    </form>
  );

  return (
    <main
      id="main-content"
      className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4"
    >
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-900 p-8 shadow-lg">
        {state.kind === 'verifying' && (
          <p role="status" className="text-center text-gray-700 dark:text-gray-300">
            Verifying your email…
          </p>
        )}

        {state.kind === 'verified' && (
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Email verified</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">Your account is now active.</p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              Continue to dashboard
            </Link>
          </div>
        )}

        {(state.kind === 'expired' || state.kind === 'invalid') && (
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {state.kind === 'expired' ? 'This link has expired' : 'This link is no longer valid'}
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Verification links are single-use and expire after 24 hours. Enter your email to get a new one.
            </p>
            {resendForm}
          </div>
        )}

        {state.kind === 'missing' && (
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Verify your email</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Open the verification link from your email. If you did not receive it, request a new one.
            </p>
            {resendForm}
          </div>
        )}

        {state.kind === 'error' && (
          <div role="alert">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">We could not verify your email</h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">Something went wrong. Please try again in a moment.</p>
          </div>
        )}
      </div>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<p className="p-8 text-center">Loading…</p>}>
      <VerifyEmailContent />
    </Suspense>
  );
}
