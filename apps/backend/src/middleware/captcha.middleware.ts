/**
 * CAPTCHA verification middleware using hCaptcha.
 *
 * Configuration via environment variables:
 *   HCAPTCHA_SECRET_KEY  — hCaptcha secret key (required in production)
 *   HCAPTCHA_ENABLED     — set to "false" to bypass verification OUTSIDE production
 *
 * The client must send the hCaptcha response token in the request body as
 * the field `captchaToken`.
 *
 * Responses:
 *   422 CAPTCHA_TOKEN_MISSING  — no token supplied
 *   422 CAPTCHA_INVALID        — provider rejected the token
 *   422 CAPTCHA_EXPIRED        — token expired or already used (retry the challenge)
 *   503 CAPTCHA_MISCONFIGURED  — secret missing in production (fail-closed)
 *   503 CAPTCHA_UNAVAILABLE    — provider timed out, errored, or returned an unreadable
 *                                response. Always `retryable: true` with Retry-After.
 *                                The request is NOT accepted (#917).
 *
 * Fail-closed everywhere: a provider outage never silently accepts a request,
 * in any environment. The only bypass is HCAPTCHA_ENABLED=false, and that is
 * ignored when NODE_ENV=production.
 */

import type { NextFunction, Request, Response } from 'express';

const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';
export const HCAPTCHA_TIMEOUT_MS = 5000;
export const HCAPTCHA_RETRY_AFTER_SECONDS = 5;
const MAX_TOKEN_LENGTH = 4096;

interface HCaptchaVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

export type CaptchaVerifyOutcome =
  | { status: 'valid' }
  | { status: 'invalid'; expired: boolean };

/** Thrown for any provider failure: timeout, network, non-2xx, malformed body. */
export class CaptchaProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaProviderError';
  }
}

/**
 * Verify a captcha token against hCaptcha's siteverify endpoint.
 * Throws CaptchaProviderError when the outcome is unknown.
 */
export async function verifyHCaptchaToken(
  token: string,
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptchaVerifyOutcome> {
  const body = new URLSearchParams({ secret: secretKey, response: token });

  let res: globalThis.Response;
  try {
    res = await fetchImpl(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(HCAPTCHA_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CaptchaProviderError(`hCaptcha request failed: ${(err as Error).name}`);
  }

  if (!res.ok) {
    throw new CaptchaProviderError(`hCaptcha verify HTTP ${res.status}`);
  }

  let data: HCaptchaVerifyResponse;
  try {
    data = (await res.json()) as HCaptchaVerifyResponse;
  } catch {
    throw new CaptchaProviderError('hCaptcha returned an unreadable response');
  }

  if (typeof data.success !== 'boolean') {
    throw new CaptchaProviderError('hCaptcha response missing success flag');
  }
  if (data.success === true) return { status: 'valid' };

  const codes = data['error-codes'] ?? [];
  return { status: 'invalid', expired: codes.includes('timeout-or-duplicate') };
}

function isBypassAllowed(): boolean {
  return process.env.HCAPTCHA_ENABLED === 'false' && process.env.NODE_ENV !== 'production';
}

/**
 * Express middleware that verifies the `captchaToken` field in `req.body`.
 */
export function captchaMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.HCAPTCHA_ENABLED === 'false' && process.env.NODE_ENV === 'production') {
    console.error('[CAPTCHA] HCAPTCHA_ENABLED=false is ignored in production');
  }

  // Development / CI bypass (never in production).
  if (isBypassAllowed()) {
    next();
    return;
  }

  const secretKey = process.env.HCAPTCHA_SECRET_KEY;
  if (!secretKey) {
    console.error('[CAPTCHA] HCAPTCHA_SECRET_KEY is not set — rejecting request (fail-closed)');
    res.status(503).json({
      error: 'Service temporarily unavailable',
      code: 'CAPTCHA_MISCONFIGURED',
      retryable: false,
    });
    return;
  }

  const token: unknown = req.body?.captchaToken;

  if (!token || typeof token !== 'string' || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) {
    res.status(422).json({
      error: 'CAPTCHA verification required',
      code: 'CAPTCHA_TOKEN_MISSING',
    });
    return;
  }

  verifyHCaptchaToken(token.trim(), secretKey)
    .then((outcome) => {
      if (outcome.status === 'invalid') {
        res.status(422).json(
          outcome.expired
            ? {
                error: 'The security check expired or was already used. Please complete it again.',
                code: 'CAPTCHA_EXPIRED',
                retryable: true,
              }
            : {
                error: 'CAPTCHA verification failed. Please try again.',
                code: 'CAPTCHA_INVALID',
                retryable: true,
              },
        );
        return;
      }
      // Strip the token from the body so downstream handlers don't see it
      delete req.body.captchaToken;
      next();
    })
    .catch((err: unknown) => {
      // Unknown outcome: never accept. Tell the client it may retry.
      console.error('[CAPTCHA] Verification unavailable:', err instanceof Error ? err.message : 'unknown');
      res.setHeader('Retry-After', String(HCAPTCHA_RETRY_AFTER_SECONDS));
      res.status(503).json({
        error: 'The security check is temporarily unavailable. Please try again shortly.',
        code: 'CAPTCHA_UNAVAILABLE',
        retryable: true,
        retryAfterSeconds: HCAPTCHA_RETRY_AFTER_SECONDS,
      });
    });
}
