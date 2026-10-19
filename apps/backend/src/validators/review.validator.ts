import { z } from 'zod';

export const createReviewSchema = z.object({
  bookingId: z
    .string({ required_error: 'bookingId is required' })
    .uuid('bookingId must be a valid UUID'),
  targetId: z
    .string({ required_error: 'targetId is required' })
    .uuid('targetId must be a valid UUID'),
  rating: z
    .number({ required_error: 'rating is required', invalid_type_error: 'rating must be a number' })
    .int('rating must be an integer')
    .min(1, 'Rating must be between 1 and 5')
    .max(5, 'Rating must be between 1 and 5'),
  comment: z.string().max(2000, 'Comment must be at most 2000 characters').optional(),
  propertyId: z.string().uuid('propertyId must be a valid UUID').optional(),
});

export const flagReviewSchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(1, 'Flag reason cannot be blank'),
});

/** Structured report with a policy reason code. */
export const reportReviewSchema = z.object({
  reasonCode: z
    .string({ required_error: 'reasonCode is required' })
    .trim()
    .min(1, 'reasonCode cannot be blank')
    .max(50, 'reasonCode must be at most 50 characters'),
  details: z
    .string()
    .max(2000, 'Details must be at most 2000 characters')
    .optional(),
});

/** Appeal submission. */
export const submitAppealSchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(1, 'Appeal reason cannot be blank')
    .max(2000, 'Appeal reason must be at most 2000 characters'),
});

/** Appeal resolution by a moderator. */
export const resolveAppealSchema = z.object({
  approved: z.boolean({ required_error: 'approved (boolean) is required' }),
});

/** Moderation action: hide, remove, or keep a review. */
export const moderationActionSchema = z.object({
  action: z
    .string({ required_error: 'action is required' })
    .refine(
      (val) => val === 'hide' || val === 'remove' || val === 'keep',
      { message: 'action must be "hide", "remove", or "keep"' },
    ),
  policyVersion: z
    .string()
    .min(1, 'policyVersion is required')
    .max(30, 'policyVersion must be at most 30 characters'),
  policyCode: z
    .string()
    .min(1, 'policyCode is required')
    .max(50, 'policyCode must be at most 50 characters'),
  explanation: z
    .string()
    .max(2000, 'explanation must be at most 2000 characters')
    .optional(),
});

/** Enhanced reject schema with optional policy fields. */
export const rejectReviewSchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .trim()
    .min(1, 'reason is required'),
  policyVersion: z.string().max(30).optional(),
  policyCode: z.string().max(50).optional(),
  explanation: z.string().max(2000).optional(),
});

/** Repair task resolution. */
export const resolveRepairTaskSchema = z.object({
  resolutionNote: z
    .string({ required_error: 'resolutionNote is required' })
    .trim()
    .min(1, 'resolutionNote is required')
    .max(2000, 'resolutionNote must be at most 2000 characters'),
  wontFix: z.boolean().optional(),
});
