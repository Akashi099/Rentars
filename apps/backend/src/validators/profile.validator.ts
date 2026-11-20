/**
 * Zod validators for user profile update payloads.
 */

import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { ValidationError } from '@/types/errors.js';

// ─── Profile update schema ────────────────────────────────────────────────────

export const updateProfileSchema = z
  .object({
    // Trim first so whitespace-only input is rejected as empty (#918).
    name: z
      .string()
      .trim()
      .min(1, 'name must not be empty')
      .max(100, 'name must be at most 100 characters')
      .optional(),

    bio: z
      .string()
      .trim()
      .max(500, 'bio must be at most 500 characters')
      .optional()
      .nullable(),

    avatar_url: z
      .string()
      .url('avatar_url must be a valid URL')
      .max(255, 'avatar_url must be at most 255 characters')
      .optional()
      .nullable(),

    phone: z
      .string()
      .regex(
        /^\+?[1-9]\d{6,14}$/,
        'phone must be a valid international phone number (e.g. +14155552671)',
      )
      .optional()
      .nullable(),

    stellar_address: z
      .string()
      .regex(
        /^G[A-Z2-7]{55}$/,
        'stellar_address must be a valid Stellar public key',
      )
      .optional()
      .nullable(),

    // Optimistic-concurrency precondition: the `updated_at` the client last saw.
    expected_updated_at: z.string().min(10).max(64).optional(),
  })
  .refine(
    (data) => Object.keys(data).some((key) => key !== 'expected_updated_at'),
    { message: 'At least one field must be provided for update' },
  );

// ─── Middleware factory ───────────────────────────────────────────────────────

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields: Record<string, string[]> = {};
      result.error.errors.forEach((error) => {
        const field = error.path.join('.');
        if (!fields[field]) {
          fields[field] = [];
        }
        fields[field].push(error.message);
      });

      const validationError = new ValidationError('Validation failed', fields);
      next(validationError);
      return;
    }
    req.body = result.data;
    next();
  };
}
