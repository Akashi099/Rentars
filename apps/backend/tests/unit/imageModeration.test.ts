/**
 * Pure rules for image moderation (#922) and reorder validation (#921).
 */
import { describe, expect, it } from 'bun:test';
import {
  MAX_MODERATION_REASON_LENGTH,
  canTransitionImageStatus,
  isImagePubliclyVisible,
  isImageVisibleToOwner,
  validateModerationInput,
  validateReorderIds,
} from '../../src/services/imageModeration';

describe('canTransitionImageStatus', () => {
  it.each([
    ['pending', 'approved'],
    ['pending', 'rejected'],
    ['pending', 'removed'],
    ['approved', 'rejected'],
    ['approved', 'removed'],
    ['rejected', 'approved'],
    ['rejected', 'removed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionImageStatus(from, to)).toBe(true);
  });

  it.each([
    ['removed', 'approved'],
    ['removed', 'rejected'],
    ['removed', 'pending'],
    ['approved', 'pending'],
    ['rejected', 'pending'],
    ['pending', 'pending'],
    ['approved', 'approved'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransitionImageStatus(from, to)).toBe(false);
  });
});

describe('visibility', () => {
  it('serves only approved images publicly', () => {
    expect(isImagePubliclyVisible('approved')).toBe(true);
    expect(isImagePubliclyVisible('pending')).toBe(false);
    expect(isImagePubliclyVisible('rejected')).toBe(false);
    expect(isImagePubliclyVisible('removed')).toBe(false);
  });

  it('shows the owner everything except removed images', () => {
    expect(isImageVisibleToOwner('pending')).toBe(true);
    expect(isImageVisibleToOwner('approved')).toBe(true);
    expect(isImageVisibleToOwner('rejected')).toBe(true);
    expect(isImageVisibleToOwner('removed')).toBe(false);
  });
});

describe('validateModerationInput', () => {
  it('requires a reason when rejecting, so the host can correct the upload', () => {
    expect(validateModerationInput('rejected', undefined)).toMatch(/reason is required/);
    expect(validateModerationInput('rejected', '   ')).toMatch(/reason is required/);
    expect(validateModerationInput('rejected', 'Shows a person’s face')).toBeNull();
  });

  it('does not require a reason to approve or remove', () => {
    expect(validateModerationInput('approved', undefined)).toBeNull();
    expect(validateModerationInput('removed', null)).toBeNull();
  });

  it('rejects pending and unknown decisions', () => {
    expect(validateModerationInput('pending', 'x')).toMatch(/decision must be one of/);
    expect(validateModerationInput('deleted', 'x')).toMatch(/decision must be one of/);
  });

  it('caps the reason length', () => {
    const long = 'a'.repeat(MAX_MODERATION_REASON_LENGTH + 1);
    expect(validateModerationInput('rejected', long)).toMatch(/at most 500/);
    expect(
      validateModerationInput('rejected', 'a'.repeat(MAX_MODERATION_REASON_LENGTH))
    ).toBeNull();
  });
});

describe('validateReorderIds', () => {
  const existing = ['a', 'b', 'c'];

  it('accepts a permutation of the property’s images', () => {
    expect(validateReorderIds(existing, ['c', 'a', 'b'])).toBeNull();
  });

  it('rejects a partial list, which would leave display_order collisions', () => {
    expect(validateReorderIds(existing, ['a', 'b'])).toMatch(/every image/);
  });

  it('rejects duplicates', () => {
    expect(validateReorderIds(existing, ['a', 'a', 'b'])).toMatch(/duplicates/);
  });

  it('rejects an image id that belongs to another property', () => {
    expect(validateReorderIds(existing, ['a', 'b', 'zzz'])).toMatch(/does not belong/);
  });

  it('accepts an empty list only when the property has no images', () => {
    expect(validateReorderIds([], [])).toBeNull();
    expect(validateReorderIds([], ['a'])).toMatch(/every image/);
  });
});
