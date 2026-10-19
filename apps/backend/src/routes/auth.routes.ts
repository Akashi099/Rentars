import { Router } from 'express';
import { login, register, requestReset, confirmReset, refreshAccessToken, logout, logoutAllDevices, verifyEmailHandler } from '@/controllers/auth.controller.js';
import { walletChallenge, walletVerify } from '@/controllers/wallet.controller.js';
import {
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  confirmPasswordResetSchema,
  verifyEmailSchema,
  walletChallengeSchema,
  walletVerifySchema,
  validateBody,
} from '@/validators/auth.validator.js';
import { createAuthRouteLimiter, emailFromBody, stellarAddressFromBody } from '@/middleware/authRateLimit.middleware.js';
import { captchaMiddleware } from '@/middleware/captcha.middleware.js';
import { authenticate } from '@/middleware/auth.middleware.js';

const router = Router();

// Each route has its own IP bucket and, where an account identifier is in the body,
// a per-account bucket. See authRateLimit.middleware.ts for limits and failure policy.
const registerLimiter = createAuthRouteLimiter({ name: 'register', accountKey: emailFromBody });
const loginLimiter = createAuthRouteLimiter({ name: 'login', accountKey: emailFromBody });
const refreshLimiter = createAuthRouteLimiter({ name: 'refresh' });
const passwordResetRequestLimiter = createAuthRouteLimiter({ name: 'password-reset-request', accountKey: emailFromBody });
const passwordResetConfirmLimiter = createAuthRouteLimiter({ name: 'password-reset-confirm' });
const verifyEmailLimiter = createAuthRouteLimiter({ name: 'verify-email' });
const walletChallengeLimiter = createAuthRouteLimiter({ name: 'wallet-challenge', accountKey: stellarAddressFromBody });
const walletVerifyLimiter = createAuthRouteLimiter({ name: 'wallet-verify', accountKey: stellarAddressFromBody });

// POST /api/v1/auth/register — CAPTCHA required
router.post('/register', registerLimiter, validateBody(registerSchema), captchaMiddleware, register);

// POST /api/v1/auth/login — CAPTCHA required
router.post('/login', loginLimiter, validateBody(loginSchema), captchaMiddleware, login);

// POST /api/v1/auth/refresh — rotate access token using refresh token
router.post('/refresh', refreshLimiter, refreshAccessToken);

// POST /api/v1/auth/logout — revoke refresh token
router.post('/logout', logout);

// POST /api/v1/auth/logout-all-devices — revoke all refresh tokens for user
router.post('/logout-all-devices', authenticate, logoutAllDevices);

// POST /api/v1/auth/verify-email — confirm email address with token
router.post('/verify-email', verifyEmailLimiter, validateBody(verifyEmailSchema), verifyEmailHandler);

// POST /api/v1/auth/password-reset/request — CAPTCHA required
router.post('/password-reset/request', passwordResetRequestLimiter, validateBody(requestPasswordResetSchema), captchaMiddleware, requestReset);

// POST /api/v1/auth/password-reset/confirm
router.post('/password-reset/confirm', passwordResetConfirmLimiter, validateBody(confirmPasswordResetSchema), confirmReset);

router.post('/wallet/challenge', walletChallengeLimiter, validateBody(walletChallengeSchema), walletChallenge);
router.post('/wallet/verify', walletVerifyLimiter, validateBody(walletVerifySchema), walletVerify);

export default router;
