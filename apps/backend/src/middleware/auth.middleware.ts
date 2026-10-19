import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env.js';
import { getJwtSecret } from '@/config/jwtSecret.js';
import { setRequestContextUserId } from '@/services/logging.service.js';

export interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string; role?: string };
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // No fallback secret: a missing JWT_SECRET must reject tokens, never accept them.
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  try {
    const decoded = jwt.verify(token, secret) as {
      userId: string;
      role?: string;
    };
    // Populate both shapes so legacy code (req.userId) and newer code (req.user.id) work.
    req.userId = decoded.userId;
    req.user = { id: decoded.userId, role: decoded.role };
    // Make the user id available to log calls made later in this request's
    // async chain (see logging.service.ts's AsyncLocalStorage-based context).
    setRequestContextUserId(decoded.userId);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Restricts access to users whose JWT `role` claim is one of `roles`.
 * Must run after `authenticate` so `req.user.role` is populated.
 */
export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (!role) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(role)) {
      res.status(403).json({ error: 'Forbidden: insufficient role' });
      return;
    }
    next();
  };
}
