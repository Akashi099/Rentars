'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RegisterForm } from '@/components/auth/RegisterForm';
import { type RegisterInput } from '@/validations/auth.schema';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n/useTranslations';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const t = useTranslations('auth');

  const handleRegister = async (data: RegisterInput & { captchaToken: string }) => {
    try {
      setError(null);
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const err = await response.json();
        // CAPTCHA responses carry a user-facing message, including retry guidance (#917).
        const captchaMessage =
          typeof err.code === 'string' && err.code.startsWith('CAPTCHA_') && typeof err.error === 'string'
            ? err.error
            : null;
        throw new Error(captchaMessage || err.message || t('registerFailed'));
      }

      toast.success(t('accountCreated'));
      router.push('/login');
    } catch (err) {
      const message = err instanceof Error ? err.message : t('registerFailed');
      setError(message);
      toast.error(message);
    }
  };

  return (
    <main
      id="main-content"
      className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center px-4"
    >
      <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-lg shadow-lg p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('joinRentars')}</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">{t('joinRentarsSubtitle')}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300 text-sm"
          >
            {error}
          </div>
        )}

        <RegisterForm onSubmit={handleRegister} />

        <p className="text-center text-gray-600 dark:text-gray-400 text-sm mt-8">
          {t('alreadyHaveAccount')}{' '}
          <Link href="/login" className="text-blue-600 hover:underline font-medium">
            {t('signInLink')}
          </Link>
        </p>
      </div>
    </main>
  );
}
