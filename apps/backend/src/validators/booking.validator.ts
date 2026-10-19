/**
 * Zod validators for booking-related request bodies.
 */

import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';
import { ValidationError } from '@/types/errors.js';

// ─── Create booking schema ────────────────────────────────────────────────────

export const createBookingSchema = z
  .object({
    property_id: z
      .string({ required_error: 'property_id is required' })
      .uuid('property_id must be a valid UUID'),

    check_in: z
      .string({ required_error: 'check_in is required' })
      .date('check_in must be a valid ISO date (YYYY-MM-DD)'),

    check_out: z
      .string({ required_error: 'check_out is required' })
      .date('check_out must be a valid ISO date (YYYY-MM-DD)'),

    guest_count: z
      .number({ required_error: 'guest_count is required', invalid_type_error: 'guest_count must be a number' })
      .int('guest_count must be an integer')
      .positive('guest_count must be a positive integer'),

    rules_acknowledged_at: z
      .string({ required_error: 'rules_acknowledged_at is required' })
      .datetime('rules_acknowledged_at must be a valid ISO 8601 datetime'),

    /**
     * Platform policy version string the tenant agreed to (from GET /api/v1/policy/current).
     * Required so the accepted terms snapshot is immutably stored with the booking.
     */
    terms_version: z
      .string({ required_error: 'terms_version is required' })
      .min(1, 'terms_version must not be empty'),

    /**
     * UTC timestamp when the tenant ticked the terms checkbox in the UI.
     */
    terms_accepted_at: z
      .string({ required_error: 'terms_accepted_at is required' })
      .datetime('terms_accepted_at must be a valid ISO 8601 datetime'),

    total_price: z
      .number({ invalid_type_error: 'total_price must be a number' })
      .positive('total_price must be positive')
      .optional(),

    stellar_address: z
      .string()
      .regex(/^G[A-Z2-7]{55}$/, 'stellar_address must be a valid Stellar public key')
      .optional(),
  })
  .refine(
    (data) => new Date(data.check_out) > new Date(data.check_in),
    { message: 'check_out must be after check_in', path: ['check_out'] },
  )
  .refine(
    (data) => new Date(data.check_in) >= new Date(new Date().toISOString().split('T')[0]),
    { message: 'check_in must not be in the past', path: ['check_in'] },
  );

// ─── Update booking schema ────────────────────────────────────────────────────

export const updateBookingSchema = z.object({
  status: z.enum(['Pending', 'Confirmed', 'Cancelled', 'Completed', 'Disputed'], {
    errorMap: () => ({
      message: 'status must be one of: Pending, Confirmed, Cancelled, Completed, Disputed',
    }),
  }).optional(),
  escrow_id: z.string().max(255).optional(),
});

// ─── Cancel booking schema ────────────────────────────────────────────────────

export const cancelBookingSchema = z.object({
  reason: z
    .string()
    .min(1, 'reason must not be empty')
    .max(2000, 'reason must not exceed 2000 characters')
    .optional(),
});

// ─── Dispute schemas ──────────────────────────────────────────────────────────

export const raiseDisputeSchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .min(10, 'reason must be at least 10 characters')
    .max(2000, 'reason must not exceed 2000 characters'),
  details: z
    .string()
    .max(5000, 'details must not exceed 5000 characters')
    .optional(),
});

export const resolveDisputeSchema = z.object({
  resolution: z.enum(['refund_tenant', 'release_to_host'], {
    errorMap: () => ({
      message: 'resolution must be either refund_tenant or release_to_host',
    }),
  }),
  admin_notes: z
    .string()
    .max(2000, 'admin_notes must not exceed 2000 characters')
    .optional(),
});

// ─── Modification schemas ─────────────────────────────────────────────────────

export const requestModificationSchema = z.object({
  requested_start: z
    .string({ required_error: 'requested_start is required' })
    .date('requested_start must be a valid ISO date (YYYY-MM-DD)'),
  requested_end: z
    .string({ required_error: 'requested_end is required' })
    .date('requested_end must be a valid ISO date (YYYY-MM-DD)'),
  guest_count: z
    .number({ invalid_type_error: 'guest_count must be a number' })
    .int('guest_count must be an integer')
    .positive('guest_count must be a positive integer')
    .optional(),
  reason: z
    .string()
    .max(1000, 'reason must not exceed 1000 characters')
    .optional(),
}).refine(
  (data) => new Date(data.requested_end) > new Date(data.requested_start),
  { message: 'requested_end must be after requested_start', path: ['requested_end'] },
);

// ─── Middleware factory ───────────────────────────────────────────────────────

export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields: Record<string, string[]> = {};
      result.error.issues.forEach((error) => {
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
