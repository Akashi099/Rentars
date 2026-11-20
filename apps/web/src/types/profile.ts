/** Canonical profile as returned by GET /api/profile (owner view) (#918). */
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
  completeness?: { score: number; maxScore: number; missingFields: string[] };
}

/** Fields the profile form can send. Omitted keys are left unchanged on the server. */
export interface ProfileUpdateData {
  name?: string;
  phone?: string | null;
  avatar_url?: string | null;
  stellar_address?: string | null;
  expected_updated_at?: string;
}
