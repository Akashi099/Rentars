/**
 * Pure rules for property image moderation (#922) and reorder validation (#921).
 *
 * No I/O here. The service layer calls these before touching the database, and
 * the tests exercise them directly.
 */

export const IMAGE_MODERATION_STATUSES = ['pending', 'approved', 'rejected', 'removed'] as const;
export type ImageModerationStatus = (typeof IMAGE_MODERATION_STATUSES)[number];

/** Decisions a moderator can make. 'pending' is the starting state, never a decision. */
export type ImageModerationDecision = Exclude<ImageModerationStatus, 'pending'>;

const TRANSITIONS: Record<ImageModerationStatus, readonly ImageModerationStatus[]> = {
  pending: ['approved', 'rejected', 'removed'],
  approved: ['rejected', 'removed'],
  rejected: ['approved', 'removed'],
  removed: [],
};

export const MAX_MODERATION_REASON_LENGTH = 500;

export function canTransitionImageStatus(
  from: ImageModerationStatus,
  to: ImageModerationStatus
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Only approved images may appear on public property responses or in search-linked media. */
export function isImagePubliclyVisible(status: ImageModerationStatus): boolean {
  return status === 'approved';
}

/** The owner can see everything except images removed by a moderator. */
export function isImageVisibleToOwner(status: ImageModerationStatus): boolean {
  return status !== 'removed';
}

/**
 * A rejection must say why, so the host can correct it. Removal does not require a
 * reason, because a removed image is not returned to the host at all.
 * Returns an error message, or null when the input is acceptable.
 */
export function validateModerationInput(
  decision: string,
  reason: string | undefined | null
): string | null {
  if (
    !IMAGE_MODERATION_STATUSES.includes(decision as ImageModerationStatus) ||
    decision === 'pending'
  ) {
    return 'decision must be one of: approved, rejected, removed';
  }
  const trimmed = (reason ?? '').trim();
  if (decision === 'rejected' && trimmed.length === 0) {
    return 'A reason is required when rejecting an image';
  }
  if (trimmed.length > MAX_MODERATION_REASON_LENGTH) {
    return `reason must be at most ${MAX_MODERATION_REASON_LENGTH} characters`;
  }
  return null;
}

/**
 * The orderedIds must be exactly the set of the property's current image ids, with no
 * duplicates and no foreign ids. A partial list would leave display_order collisions,
 * and a foreign id would move an image that belongs to another property.
 * Returns an error message, or null when the order is valid.
 */
export function validateReorderIds(
  existingIds: readonly string[],
  orderedIds: readonly string[]
): string | null {
  if (orderedIds.length !== existingIds.length) {
    return 'orderedIds must include every image for this property exactly once';
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    return 'orderedIds must not contain duplicates';
  }
  const existing = new Set(existingIds);
  if (orderedIds.some((id) => !existing.has(id))) {
    return 'orderedIds contains an image that does not belong to this property';
  }
  return null;
}
