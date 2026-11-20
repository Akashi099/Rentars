/**
 * Builds the PATCH /api/profile body for the profile form (#918).
 *
 * Rules:
 *  - Only fields the user actually changed are sent, so untouched values are never overwritten.
 *  - An optional field cleared by the user is sent as null (an explicit clear).
 *  - Name must be non-empty after trimming.
 *  - Phone and Stellar address are validated with the same rules as the API.
 *  - Avatars must be an http(s) URL of at most 255 characters, the column limit.
 *    Local file data is rejected rather than stored as a data URL.
 *  - When `expectedUpdatedAt` is given, it is sent so the server can detect concurrent edits.
 */

export interface SavedProfileFields {
  name?: string | null;
  phone?: string | null;
  stellar_address?: string | null;
  avatar_url?: string | null;
}

export interface ProfileDraft {
  name: string;
  phone: string;
  stellarAddress: string;
  /** Current avatar value: an http(s) URL, '' or null for none, or a local data: URL after cropping. */
  avatarUrl: string | null;
}

export type ProfilePatchField = 'name' | 'phone' | 'stellarAddress' | 'avatarUrl';

export type ProfilePatchResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; body: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<ProfilePatchField, string>> };

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const STELLAR_RE = /^G[A-Z2-7]{55}$/;
const MAX_AVATAR_URL = 255;

export function buildProfilePatch(
  saved: SavedProfileFields,
  draft: ProfileDraft,
  expectedUpdatedAt?: string
): ProfilePatchResult {
  const errors: Partial<Record<ProfilePatchField, string>> = {};
  const body: Record<string, unknown> = {};

  const name = draft.name.trim();
  if (name !== (saved.name ?? '').trim()) {
    if (!name) errors.name = 'Name is required.';
    else if (name.length > 100) errors.name = 'Name must be 100 characters or fewer.';
    else body.name = name;
  }

  const phone = draft.phone.trim();
  if (phone !== (saved.phone ?? '').trim()) {
    if (phone === '') body.phone = null;
    else if (!PHONE_RE.test(phone))
      errors.phone = 'Enter a valid international number, for example +14155552671.';
    else body.phone = phone;
  }

  const wallet = draft.stellarAddress.trim();
  if (wallet !== (saved.stellar_address ?? '').trim()) {
    if (wallet === '') body.stellar_address = null;
    else if (!STELLAR_RE.test(wallet))
      errors.stellarAddress = 'Enter a valid Stellar public key (starts with G, 56 characters).';
    else body.stellar_address = wallet;
  }

  const avatar = draft.avatarUrl;
  if ((avatar ?? '') !== (saved.avatar_url ?? '')) {
    if (!avatar) body.avatar_url = null;
    else if (!/^https?:\/\//i.test(avatar) || avatar.length > MAX_AVATAR_URL)
      errors.avatarUrl =
        'Photo uploads are not available yet. Use a web image link of up to 255 characters.';
    else body.avatar_url = avatar;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (Object.keys(body).length === 0) return { ok: true, changed: false };
  if (expectedUpdatedAt) body.expected_updated_at = expectedUpdatedAt;
  return { ok: true, changed: true, body };
}
