/**
 * Session revocation guard.
 *
 * Runs before routing for every request that carries a Bearer token. If the
 * token was issued before the user's session-revocation marker (set by password
 * reset or logout-all-devices), the request is rejected even though the JWT
 * signature and expiry are still valid.
 *
 * Fails closed: if the marker cannot be read, the request is rejected with 503
 * rather than accepted, because a revoked token must never pass silently.
 *
 * Requests without a verifiable token pass through; `authenticate` on each
 * protected route still produces the 401.
 */

import { getSessionRevokedBefore } from '@/services/sessionRevocation.service.js';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { structuredLog } from './logging.middleware.js';

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

export async function sessionRevocationGuard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = bearerToken(req);
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) {
    next();
    return;
  }

  let decoded: { userId?: string; iat?: number };
  try {
    decoded = jwt.verify(token, secret) as { userId?: string; iat?: number };
  } catch {
    // Invalid or expired tokens are rejected by authenticate() on the route.
    next();
    return;
  }

  if (!decoded.userId || typeof decoded.iat !== 'number') {
    next();
    return;
  }

  let revokedBefore: number | null;
  try {
    revokedBefore = await getSessionRevokedBefore(decoded.userId);
  } catch (err) {
    structuredLog({
      level: 'error',
      message: 'Session revocation check unavailable',
      timestamp: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(503).json({
      error: {
        code: 'SESSION_CHECK_UNAVAILABLE',
        message: 'Session validation is temporarily unavailable. Please retry.',
      },
    });
    return;
  }

  if (revokedBefore !== null && decoded.iat < revokedBefore) {
    res.status(401).json({
      error: {
        code: 'SESSION_REVOKED',
        message: 'Your session has ended. Please log in again.',
      },
    });
    return;
  }

  next();
}
