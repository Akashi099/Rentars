import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import {
  loginUser,
  registerUser,
  generateWalletChallenge,
  verifyWalletChallenge,
  requestPasswordReset,
  confirmPasswordReset,
  verifyEmail,
} from '@/services/auth.service.js';
import { consumeRefreshToken, revokeRefreshToken, revokeAllUserRefreshTokens } from '@/services/refreshToken.service.js';
import { securityLogger } from '@/services/logging.service.js';
import { markUserSessionsRevoked } from '@/services/sessionRevocation.service.js';
import { auditLogger } from '@/services/auditLogger.service.js';
import { env } from '@/config/env.js';
import { AuthError } from '@/types/errors.js';

export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    const result = await registerUser(email, password);
    res.status(201).json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = req.body;
    const result = await loginUser(email, password);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function walletChallenge(req: Request, res: Response): Promise<void> {
  try {
    const { stellar_address } = req.body;
    const result = await generateWalletChallenge(stellar_address);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function walletVerify(req: Request, res: Response): Promise<void> {
  try {
    const { stellar_address, challenge, signature } = req.body;
    const result = await verifyWalletChallenge(stellar_address, challenge, signature);
    res.json(result.data);
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function verifyEmailHandler(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.body;
    await verifyEmail(token);
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    if (err instanceof AuthError) {
      throw err;
    }
    throw err;
  }
}

export async function requestReset(req: Request, res: Response): Promise<void> {
  const { email } = req.body;
  await requestPasswordReset(email);
  res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
}

export async function confirmReset(req: Request, res: Response): Promise<void> {
  const { token, password } = req.body;
  await confirmPasswordReset(token, password);
  res.json({ message: 'Password updated successfully. Please log in with your new password.' });
}

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken: string }
 * Returns new access token + rotated refresh token.
 */
export async function refreshAccessToken(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken?: string };

  if (!refreshToken) {
    res.status(400).json({ error: { code: 'MISSING_TOKEN', message: 'refreshToken is required' } });
    return;
  }

  const result = await consumeRefreshToken(refreshToken);
  if (!result) {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Refresh token is invalid or expired' } });
    return;
  }

  const { userId, role, newRefreshToken } = result;

  const newAccessToken = jwt.sign({ userId, role }, env.JWT_SECRET, { expiresIn: '15m' });

  res.json({ token: newAccessToken, refreshToken: newRefreshToken });
}

/**
 * POST /api/v1/auth/logout
 * Body: { refreshToken: string }
 * Revokes the refresh token so it cannot be used again.
 */
export async function logout(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body as { refreshToken?: string };

  let userId: string | undefined;

  // Extract user ID from access token header for audit logging
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], env.JWT_SECRET) as { userId?: string };
      userId = decoded.userId;
    } catch {
      // token may be expired — still allow logout
    }
  }

  if (refreshToken) {
    await revokeRefreshToken(refreshToken);
  }

  if (userId) {
    await securityLogger.logAuthEvent('logout', userId);
    await auditLogger.log({
      actorId: userId,
      action: 'auth.logout',
      resourceType: 'auth',
      ip: req.ip,
    });
  }

  res.json({ message: 'Logged out successfully.' });
}

/**
 * POST /api/v1/auth/logout-all-devices
 * Revokes all refresh tokens for the authenticated user across all devices.
 * Used when password is reset or compromise is suspected.
 */
export async function logoutAllDevices(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Authorization required' } });
    return;
  }

  let userId: string | undefined;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], env.JWT_SECRET) as { userId?: string };
    userId = decoded.userId;
  } catch (err) {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    return;
  }

  if (!userId) {
    res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'No user ID in token' } });
    return;
  }

  await revokeAllUserRefreshTokens(userId);
  // Access tokens are stateless, so also reject every token already issued to this user.
  await markUserSessionsRevoked(userId);

  await auditLogger.log({
    actorId: userId,
    action: 'auth.logout_all_devices',
    resourceType: 'auth',
    ip: req.ip,
    meta: { reason: 'user_initiated' },
  });

  res.json({ message: 'Logged out from all devices successfully.' });
}
