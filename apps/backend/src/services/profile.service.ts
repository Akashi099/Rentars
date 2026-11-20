import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

/**
 * Profile service (#918).
 *
 * Field ownership (see docs/SECURITY_AUTH_HARDENING.md, "Profile field ownership"):
 *  - Public  (returned by getPublicProfile): user_id, name, avatar_url, stellar_address, verification_status
 *  - Private (owner only):                   phone, bio, updated_at, created_at
 *  - Server-owned (never writable here):     id, user_id, role, status, verified, created_at, updated_at
 *
 * The API uses `name`; the `profiles` table stores it as `display_name`. This module
 * maps between the two in one place so every surface reads the same value.
 */

/** Canonical API shape. */
export interface UserProfile {
  user_id: string;
  name?: string | null;
  avatar_url?: string | null;
  phone?: string | null;
  bio?: string | null;
  stellar_address?: string | null;
  verification_status?: 'unverified' | 'verified';
  created_at?: string;
  updated_at?: string;
}

export interface ProfileCompleteness {
  score: number;
  maxScore: number;
  missingFields: string[];
}

export type PublicProfile = Pick<
  UserProfile,
  'user_id' | 'name' | 'avatar_url' | 'stellar_address' | 'verification_status'
>;

export type ProfileUpdateOptions = {
  /** Optional optimistic-concurrency precondition: the `updated_at` the client last saw. */
  expectedUpdatedAt?: string;
};

export type ProfileServiceError = { code?: 'CONFLICT' | 'NOT_FOUND' | 'DB_ERROR'; current?: UserProfile };

/** Columns that exist on the `profiles` table. Anything else is never selected or written. */
const OWNER_COLUMNS = 'user_id, display_name, avatar_url, phone, bio, stellar_address, verified, created_at, updated_at';
const PUBLIC_COLUMNS = 'user_id, display_name, avatar_url, stellar_address, verified';

const PROTECTED_PROFILE_FIELDS = new Set([
  'id',
  'user_id',
  'role',
  'status',
  'verified',
  'verification_status',
  'created_at',
  'updated_at',
]);

/** Returns a copy of `data` without server-owned fields. */
export function omitProtectedFields<T extends Record<string, unknown>>(data: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!PROTECTED_PROFILE_FIELDS.has(key)) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

type Row = Record<string, unknown>;

function toApiProfile(row: Row): UserProfile {
  return {
    user_id: String(row.user_id),
    name: (row.display_name as string | null | undefined) ?? null,
    avatar_url: (row.avatar_url as string | null | undefined) ?? null,
    phone: (row.phone as string | null | undefined) ?? null,
    bio: (row.bio as string | null | undefined) ?? null,
    stellar_address: (row.stellar_address as string | null | undefined) ?? null,
    verification_status: row.verified === true ? 'verified' : 'unverified',
    created_at: row.created_at as string | undefined,
    updated_at: row.updated_at as string | undefined,
  };
}

function toPublicProfile(row: Row): PublicProfile {
  return {
    user_id: String(row.user_id),
    name: (row.display_name as string | null | undefined) ?? null,
    avatar_url: (row.avatar_url as string | null | undefined) ?? null,
    stellar_address: (row.stellar_address as string | null | undefined) ?? null,
    verification_status: row.verified === true ? 'verified' : 'unverified',
  };
}

/** Maps API field names to column names. Unknown keys are dropped. */
export function toColumnPatch(input: Record<string, unknown>): Row {
  const allowed: Record<string, string> = {
    name: 'display_name',
    avatar_url: 'avatar_url',
    phone: 'phone',
    bio: 'bio',
    stellar_address: 'stellar_address',
  };
  const out: Row = {};
  for (const [key, value] of Object.entries(omitProtectedFields(input))) {
    const column = allowed[key];
    if (column && value !== undefined) out[column] = value;
  }
  return out;
}

/**
 * Retrieve a user's full profile by their user ID (owner view).
 */
export async function getProfile(userId: string): Promise<ServiceResponse<UserProfile>> {
  if (!userId) return { success: false, error: 'User ID is required' };

  const { data, error } = await supabase
    .from('profiles')
    .select(OWNER_COLUMNS)
    .eq('user_id', userId)
    .single();

  if (error || !data) return { success: false, error: 'Profile not found' };
  return { success: true, data: toApiProfile(data as Row) };
}

/**
 * Partial update with PATCH semantics.
 *
 * Only keys present in `profileData` are written, so omitted fields keep their
 * stored values. An explicit `null` clears an optional field. The canonical
 * updated row is returned.
 *
 * If `options.expectedUpdatedAt` is given, the write only applies when the stored
 * `updated_at` still matches. Otherwise it fails with code CONFLICT and returns
 * the current profile, so the client can reconcile without losing data.
 */
export async function updateProfile(
  userId: string,
  profileData: Record<string, unknown>,
  options: ProfileUpdateOptions = {},
): Promise<ServiceResponse<UserProfile> & { errorCode?: ProfileServiceError['code']; current?: UserProfile }> {
  if (!userId) return { success: false, error: 'User ID is required' };

  const patch = toColumnPatch(profileData);
  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No fields provided for update' };
  }
  const now = new Date().toISOString();

  if (options.expectedUpdatedAt) {
    const { data, error } = await supabase
      .from('profiles')
      .update({ ...patch, updated_at: now })
      .eq('user_id', userId)
      .eq('updated_at', options.expectedUpdatedAt)
      .select(OWNER_COLUMNS)
      .maybeSingle();

    if (error) return { success: false, error: error.message, errorCode: 'DB_ERROR' };
    if (!data) {
      const current = await getProfile(userId);
      if (!current.success || !current.data) {
        return { success: false, error: 'Profile not found', errorCode: 'NOT_FOUND' };
      }
      return {
        success: false,
        error: 'Profile was changed by another update. Review the latest values and try again.',
        errorCode: 'CONFLICT',
        current: current.data,
      };
    }
    return { success: true, data: toApiProfile(data as Row) };
  }

  const { data, error } = await supabase
    .from('profiles')
    .upsert({ ...patch, user_id: userId, updated_at: now }, { onConflict: 'user_id' })
    .select(OWNER_COLUMNS)
    .single();

  if (error) return { success: false, error: error.message, errorCode: 'DB_ERROR' };
  return { success: true, data: toApiProfile(data as Row) };
}

/**
 * Update the Stellar wallet address associated with a user's profile.
 */
export async function updateStellarAddress(
  userId: string,
  stellarAddress: string,
): Promise<ServiceResponse<UserProfile>> {
  if (!userId) return { success: false, error: 'User ID is required' };
  if (!stellarAddress) return { success: false, error: 'Stellar address is required' };

  const { data, error } = await supabase
    .from('profiles')
    .upsert({ user_id: userId, stellar_address: stellarAddress, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    .select(OWNER_COLUMNS)
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: toApiProfile(data as Row) };
}

/**
 * Public view: never includes phone, bio, or timestamps beyond what is listed.
 */
export async function getPublicProfile(userId: string): Promise<ServiceResponse<PublicProfile>> {
  if (!userId) return { success: false, error: 'User ID is required' };

  const { data, error } = await supabase
    .from('profiles')
    .select(PUBLIC_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return { success: false, error: 'Profile not found' };
  return { success: true, data: toPublicProfile(data as Row) };
}

const COMPLETENESS_WEIGHTS: Record<string, number> = {
  name: 25,
  avatar_url: 25,
  phone: 25,
  stellar_address: 25,
};

export function computeProfileCompleteness(profile: Partial<UserProfile>): ProfileCompleteness {
  let score = 0;
  const missingFields: string[] = [];

  for (const [field, weight] of Object.entries(COMPLETENESS_WEIGHTS)) {
    const value = profile[field as keyof UserProfile];
    const hasValue = typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
    if (hasValue) {
      score += weight;
    } else {
      missingFields.push(field);
    }
  }

  return {
    score,
    maxScore: Object.values(COMPLETENESS_WEIGHTS).reduce((a, b) => a + b, 0),
    missingFields,
  };
}
