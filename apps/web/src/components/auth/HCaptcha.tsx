'use client';

import { useEffect, useRef, useCallback, useState } from 'react';

/**
 * hCaptcha widget wrapper.
 *
 * Renders the challenge and calls `onVerify` with the response token once the
 * user completes it. `onExpire` fires when the token expires or the challenge
 * is abandoned, so the parent can clear it. `onError` fires on challenge
 * errors.
 *
 * Recovery states (#917), all announced through a live region:
 *  - script-load failure: "Try again" reloads the provider script
 *  - challenge error:     "Try again" resets the widget for a new challenge
 *
 * `resetKey` changes after each submit attempt. The parent sends a one-time
 * token only once, so a new challenge must be shown for the next attempt.
 *
 * Set NEXT_PUBLIC_HCAPTCHA_SITE_KEY in your .env.local.
 * Set NEXT_PUBLIC_HCAPTCHA_ENABLED=false to skip rendering in development.
 */

declare global {
  interface Window {
    hcaptcha?: {
      render: (container: HTMLElement, params: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
    _hcaptchaOnLoad?: () => void;
  }
}

interface HCaptchaProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (code: string) => void;
  resetKey?: number;
}

type Status = 'loading' | 'ready' | 'load-error' | 'challenge-error';

const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?onload=_hcaptchaOnLoad&render=explicit';

export function HCaptcha({ onVerify, onExpire, onError, resetKey }: HCaptchaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [attempt, setAttempt] = useState(0);
  const lastResetKey = useRef(resetKey);

  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY;
  const enabled = process.env.NEXT_PUBLIC_HCAPTCHA_ENABLED !== 'false';

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.hcaptcha || !siteKey) return;
    if (widgetIdRef.current !== null) return; // already rendered

    widgetIdRef.current = window.hcaptcha.render(containerRef.current, {
      sitekey: siteKey,
      callback: (token: string) => {
        setStatus('ready');
        onVerify(token);
      },
      'expired-callback': () => {
        onExpire?.();
      },
      'error-callback': (code?: string) => {
        setStatus('challenge-error');
        onExpire?.();
        onError?.(typeof code === 'string' ? code : 'unknown');
      },
    });
    setStatus('ready');
  }, [siteKey, onVerify, onExpire, onError]);

  // Reset the widget after each submit attempt (tokens are single-use).
  useEffect(() => {
    if (resetKey === lastResetKey.current) return;
    lastResetKey.current = resetKey;
    if (widgetIdRef.current !== null && window.hcaptcha) {
      try {
        window.hcaptcha.reset(widgetIdRef.current);
      } catch {
        // widget already gone; a re-render will create a fresh one
      }
    }
  }, [resetKey]);

  useEffect(() => {
    if (!enabled || !siteKey) return;

    // If the hCaptcha script is already loaded, render immediately
    if (window.hcaptcha) {
      renderWidget();
      return;
    }

    // Otherwise load the script and render on load
    window._hcaptchaOnLoad = renderWidget;

    let script = document.querySelector<HTMLScriptElement>('script[src*="hcaptcha.com/1/api.js"]');
    if (script && attempt > 0) {
      // Retry: drop the failed element so the browser fetches it again.
      script.remove();
      script = null;
    }
    if (!script) {
      script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onerror = () => setStatus('load-error');
      document.head.appendChild(script);
    }

    return () => {
      if (widgetIdRef.current !== null && window.hcaptcha) {
        try {
          window.hcaptcha.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }
    };
  }, [enabled, siteKey, renderWidget, attempt]);

  const retry = () => {
    if (status === 'challenge-error' && widgetIdRef.current !== null && window.hcaptcha) {
      try {
        window.hcaptcha.reset(widgetIdRef.current);
        setStatus('ready');
      } catch {
        setAttempt((n) => n + 1);
      }
      return;
    }
    setStatus('loading');
    setAttempt((n) => n + 1);
  };

  // Dev bypass — show a notice instead of the widget
  if (!enabled || !siteKey) {
    return (
      <div className="text-xs text-gray-400 border border-dashed border-gray-300 rounded px-3 py-2">
        CAPTCHA disabled in development
      </div>
    );
  }

  const message =
    status === 'load-error'
      ? 'The security check could not load. Check your connection, then try again.'
      : status === 'challenge-error'
        ? 'The security check failed. Try the challenge again.'
        : null;

  return (
    <div>
      <div ref={containerRef} className="h-captcha" />
      {status === 'loading' && (
        <p className="text-xs text-gray-500" role="status">
          Loading security check…
        </p>
      )}
      {message && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-700">
          <span>{message}</span>
          <button
            type="button"
            onClick={retry}
            className="underline font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
