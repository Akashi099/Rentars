/**
 * Moderation Policy Service
 *
 * Single source of truth for the versioned content moderation policy.
 *
 * Design principles:
 *   - Every report reason maps to a documented policy and enforcement action.
 *   - UI, API, and moderator tools use the same versioned taxonomy.
 *   - Policy changes create a NEW version row; they never overwrite
 *     historical decisions, which always reference the version that was
 *     in effect at the time of the decision.
 *
 * The policy is stored in the `moderation_policy_versions` and
 * `moderation_reason_mappings` database tables (migration 00068).
 * This service reads from those tables and provides validation helpers.
 */

import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EnforcementAction = 'review' | 'hide' | 'remove' | 'warn' | 'ban';
export type ModerationSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ModerationPolicyVersion {
  id: string;
  version: string;
  effective_date: string;
  summary: string;
  policy_url: string | null;
  appeal_window_days: number;
  retention_days: number;
  is_active: boolean;
  created_at: string;
}

export interface ModerationReasonMapping {
  id: string;
  policy_version_id: string;
  reason_code: string;
  reason_label: string;
  reason_description: string;
  default_action: EnforcementAction;
  notify_author: boolean;
  notify_reporter: boolean;
  severity: ModerationSeverity;
  sort_order: number;
}

export interface ModerationPolicySnapshot {
  version: string;
  effectiveDate: string;
  appealWindowDays: number;
  retentionDays: number;
  summary: string;
  policyUrl: string | null;
  reasons: Array<{
    code: string;
    label: string;
    description: string;
    defaultAction: EnforcementAction;
    notifyAuthor: boolean;
    notifyReporter: boolean;
    severity: ModerationSeverity;
  }>;
}

// ─── In-memory cache of the active policy ─────────────────────────────────────

let cachedPolicy: {
  snapshot: ModerationPolicySnapshot;
  reasonMappings: Map<string, ModerationReasonMapping>;
  fetchedAt: number;
} | null = null;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the currently active moderation policy snapshot.
 *
 * This is the public-facing snapshot shown to users and used by the UI to
 * display report reason options.  It is cached for 5 minutes to avoid
 * querying the database on every request.
 */
export async function getCurrentModerationPolicy(): Promise<ServiceResponse<ModerationPolicySnapshot>> {
  // Return cached snapshot if fresh.
  if (cachedPolicy && Date.now() - cachedPolicy.fetchedAt < CACHE_TTL_MS) {
    return { success: true, data: cachedPolicy.snapshot };
  }

  // Fetch the active version from the database.
  const { data: version, error: versionError } = await supabase
    .from('moderation_policy_versions')
    .select('*')
    .eq('is_active', true)
    .single();

  if (versionError || !version) {
    // Fall back to the hardcoded default if the table isn't populated yet
    // (e.g. during initial setup or if migrations haven't run).
    const fallback = getFallbackPolicySnapshot();
    return { success: true, data: fallback };
  }

  const v = version as ModerationPolicyVersion;

  // Fetch all reason mappings for this version.
  const { data: mappings, error: mappingsError } = await supabase
    .from('moderation_reason_mappings')
    .select('*')
    .eq('policy_version_id', v.id)
    .order('sort_order', { ascending: true });

  if (mappingsError || !mappings) {
    const fallback = getFallbackPolicySnapshot();
    return { success: true, data: fallback };
  }

  const reasonMappings = (mappings as ModerationReasonMapping[]) ?? [];
  const mappingMap = new Map<string, ModerationReasonMapping>();
  for (const m of reasonMappings) {
    mappingMap.set(m.reason_code, m);
  }

  const snapshot: ModerationPolicySnapshot = {
    version: v.version,
    effectiveDate: v.effective_date,
    appealWindowDays: v.appeal_window_days,
    retentionDays: v.retention_days,
    summary: v.summary,
    policyUrl: v.policy_url,
    reasons: reasonMappings.map((m) => ({
      code: m.reason_code,
      label: m.reason_label,
      description: m.reason_description,
      defaultAction: m.default_action,
      notifyAuthor: m.notify_author,
      notifyReporter: m.notify_reporter,
      severity: m.severity,
    })),
  };

  // Update the cache.
  cachedPolicy = {
    snapshot,
    reasonMappings: mappingMap,
    fetchedAt: Date.now(),
  };

  return { success: true, data: snapshot };
}

/**
 * Get the appeal window in days for the current policy.
 * Falls back to 14 days if the policy can't be loaded.
 */
export async function getAppealWindowDays(): Promise<number> {
  const result = await getCurrentModerationPolicy();
  return result.data?.appealWindowDays ?? 14;
}

/**
 * Validate that a report reason code is supported by the current policy.
 *
 * @param reasonCode - The reason code to validate
 * @returns true if the reason is supported, false otherwise
 */
export async function isValidReportReason(reasonCode: string): Promise<boolean> {
  // Ensure the cache is populated.
  if (!cachedPolicy || Date.now() - cachedPolicy.fetchedAt >= CACHE_TTL_MS) {
    await getCurrentModerationPolicy();
  }

  if (cachedPolicy?.reasonMappings.has(reasonCode)) {
    return true;
  }

  // Also check the fallback list for resilience.
  return FALLBACK_REASON_CODES.includes(reasonCode);
}

/**
 * Get the reason mapping for a specific reason code from the current policy.
 *
 * @param reasonCode - The reason code to look up
 * @returns The mapping or null if not found
 */
export async function getReasonMapping(
  reasonCode: string,
): Promise<ModerationReasonMapping | null> {
  // Ensure the cache is populated.
  if (!cachedPolicy || Date.now() - cachedPolicy.fetchedAt >= CACHE_TTL_MS) {
    await getCurrentModerationPolicy();
  }

  if (cachedPolicy?.reasonMappings.has(reasonCode)) {
    return cachedPolicy.reasonMappings.get(reasonCode)!;
  }

  // Check fallback.
  return getFallbackReasonMapping(reasonCode);
}

/**
 * Get the enforcement action for a report reason.
 *
 * @param reasonCode - The reason code to look up
 * @returns The default enforcement action, or 'review' as a safe default
 */
export async function getActionForReason(
  reasonCode: string,
): Promise<EnforcementAction> {
  const mapping = await getReasonMapping(reasonCode);
  return mapping?.default_action ?? 'review';
}

/**
 * Get all supported report reason codes for the current policy.
 * Used by UI to populate the report reason dropdown.
 */
export async function getSupportedReasonCodes(): Promise<string[]> {
  const result = await getCurrentModerationPolicy();
  if (!result.success || !result.data) {
    return [...FALLBACK_REASON_CODES];
  }
  return result.data.reasons.map((r) => r.code);
}

/**
 * Get a specific policy version by version string.
 * Used to display the policy that was in effect when a historical
 * decision was made — never overwrites the current policy.
 *
 * @param version - The policy version string (e.g. '2026-10-16.1')
 */
export async function getPolicyVersion(
  version: string,
): Promise<ServiceResponse<ModerationPolicySnapshot>> {
  const { data: v, error } = await supabase
    .from('moderation_policy_versions')
    .select('*')
    .eq('version', version)
    .single();

  if (error || !v) {
    return { success: false, error: `Policy version ${version} not found` };
  }

  const pv = v as ModerationPolicyVersion;

  const { data: mappings } = await supabase
    .from('moderation_reason_mappings')
    .select('*')
    .eq('policy_version_id', pv.id)
    .order('sort_order', { ascending: true });

  const reasonMappings = (mappings as ModerationReasonMapping[]) ?? [];

  const snapshot: ModerationPolicySnapshot = {
    version: pv.version,
    effectiveDate: pv.effective_date,
    appealWindowDays: pv.appeal_window_days,
    retentionDays: pv.retention_days,
    summary: pv.summary,
    policyUrl: pv.policy_url,
    reasons: reasonMappings.map((m) => ({
      code: m.reason_code,
      label: m.reason_label,
      description: m.reason_description,
      defaultAction: m.default_action,
      notifyAuthor: m.notify_author,
      notifyReporter: m.notify_reporter,
      severity: m.severity,
    })),
  };

  return { success: true, data: snapshot };
}

/**
 * List all policy versions (for admin audit trail).
 */
export async function listPolicyVersions(): Promise<ServiceResponse<ModerationPolicyVersion[]>> {
  const { data, error } = await supabase
    .from('moderation_policy_versions')
    .select('*')
    .order('effective_date', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as ModerationPolicyVersion[] };
}

// ─── Fallback policy (used when DB tables aren't available) ────────────────────

/**
 * The full set of supported reason codes.  This list is the fallback used
 * when the database tables aren't available (initial setup, testing).
 * It must stay in sync with the migration 00068 seed data.
 */
export const FALLBACK_REASON_CODES = [
  'spam',
  'fraud',
  'inappropriate',
  'misleading',
  'harassment',
  'discrimination',
  'unsafe_property',
  'privacy',
  'retaliatory',
  'other',
] as const;

function getFallbackReasonMapping(reasonCode: string): ModerationReasonMapping | null {
  const allMappings = getFallbackMappings();
  return allMappings.get(reasonCode) ?? null;
}

function getFallbackMappings(): Map<string, ModerationReasonMapping> {
  const fallbackId = 'fallback';
  const mappings: Array<[string, Omit<ModerationReasonMapping, 'policy_version_id' | 'id'>]> = [
    ['spam', {
      reason_code: 'spam', reason_label: 'Spam', reason_description: 'Repetitive, irrelevant, or promotional content.',
      default_action: 'review', notify_author: true, notify_reporter: true, severity: 'low', sort_order: 1,
    }],
    ['fraud', {
      reason_code: 'fraud', reason_label: 'Fraud', reason_description: 'Misrepresentation or attempts to deceive users.',
      default_action: 'remove', notify_author: true, notify_reporter: true, severity: 'critical', sort_order: 2,
    }],
    ['inappropriate', {
      reason_code: 'inappropriate', reason_label: 'Inappropriate Content', reason_description: 'Offensive or unsuitable content.',
      default_action: 'hide', notify_author: true, notify_reporter: true, severity: 'high', sort_order: 3,
    }],
    ['misleading', {
      reason_code: 'misleading', reason_label: 'Misleading Information', reason_description: 'False claims about a property.',
      default_action: 'review', notify_author: true, notify_reporter: true, severity: 'medium', sort_order: 4,
    }],
    ['harassment', {
      reason_code: 'harassment', reason_label: 'Harassment', reason_description: 'Targeted attacks or threats.',
      default_action: 'hide', notify_author: true, notify_reporter: true, severity: 'high', sort_order: 5,
    }],
    ['discrimination', {
      reason_code: 'discrimination', reason_label: 'Discrimination', reason_description: 'Disparagement based on protected characteristics.',
      default_action: 'remove', notify_author: true, notify_reporter: true, severity: 'critical', sort_order: 6,
    }],
    ['unsafe_property', {
      reason_code: 'unsafe_property', reason_label: 'Unsafe Property', reason_description: 'Dangerous conditions or safety hazards.',
      default_action: 'hide', notify_author: true, notify_reporter: true, severity: 'high', sort_order: 7,
    }],
    ['privacy', {
      reason_code: 'privacy', reason_label: 'Privacy Violation', reason_description: 'Sharing personal information or doxxing.',
      default_action: 'remove', notify_author: true, notify_reporter: true, severity: 'critical', sort_order: 8,
    }],
    ['retaliatory', {
      reason_code: 'retaliatory', reason_label: 'Retaliatory Review', reason_description: 'Review posted in retaliation rather than reflecting a genuine experience.',
      default_action: 'review', notify_author: true, notify_reporter: true, severity: 'medium', sort_order: 9,
    }],
    ['other', {
      reason_code: 'other', reason_label: 'Other', reason_description: 'Reports that do not fit a specific category.',
      default_action: 'review', notify_author: true, notify_reporter: true, severity: 'low', sort_order: 10,
    }],
  ];

  const map = new Map<string, ModerationReasonMapping>();
  for (const [code, m] of mappings) {
    map.set(code, { ...m, id: fallbackId, policy_version_id: fallbackId });
  }
  return map;
}

function getFallbackPolicySnapshot(): ModerationPolicySnapshot {
  const mappings = getFallbackMappings();
  return {
    version: '2026-10-16.1',
    effectiveDate: '2026-10-16',
    appealWindowDays: 14,
    retentionDays: 365,
    summary: 'Rentars content moderation policy covering harassment, discrimination, fraud, unsafe properties, privacy violations, and retaliatory reviews.',
    policyUrl: null,
    reasons: [...mappings.values()].sort((a, b) => a.sort_order - b.sort_order).map((m) => ({
      code: m.reason_code,
      label: m.reason_label,
      description: m.reason_description,
      defaultAction: m.default_action,
      notifyAuthor: m.notify_author,
      notifyReporter: m.notify_reporter,
      severity: m.severity,
    })),
  };
}
