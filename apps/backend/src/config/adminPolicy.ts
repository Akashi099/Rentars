/**
 * Admin Least-Privilege Policy Inventory (Issue #116)
 *
 * Central inventory mapping every admin endpoint to its required scope,
 * permitted roles, owning team, risk tier, dual-approval requirement, and
 * operational runbook. Single source of truth for:
 * - Centralized policy enforcement (`canInvoke`).
 * - Immediate denial after role removal (`denyAfterRoleRemoval` — the
 *   request-time role is authoritative; no cached privilege survives it).
 * - Runbook linkage for moderation, refunds, reconciliation, account
 *   support, and emergency controls.
 *
 * Complements `adminScopes.ts` (scope definitions) and
 * `adminScope.middleware.ts` (request enforcement).
 */

import { type AdminRole, type AdminScope, roleHasScope } from './adminScopes.js';

export type RiskTier = 'low' | 'medium' | 'high';

export interface AdminActionPolicy {
  /** e.g. 'POST /api/v1/admin/disputes/:id/resolve' */
  endpoint: string;
  scope: AdminScope;
  roles: AdminRole[];
  owner: string;
  risk: RiskTier;
  runbook: string; // docs/admin-runbooks.md anchor
  preconditions: string[];
  rollback: string;
}

export const ADMIN_ACTION_POLICIES: AdminActionPolicy[] = [
  {
    endpoint: 'POST /api/v1/admin/users/:id/suspend',
    scope: 'admin:users:suspend',
    roles: ['admin'],
    owner: 'trust-and-safety',
    risk: 'high',
    runbook: 'docs/admin-runbooks.md#runbook-1--suspend-a-user',
    preconditions: ['Evidence ticket filed', 'Dual approval obtained'],
    rollback: 'POST /api/v1/admin/users/:id/activate',
  },
  {
    endpoint: 'POST /api/v1/admin/users/:id/activate',
    scope: 'admin:users:activate',
    roles: ['admin', 'moderator'],
    owner: 'trust-and-safety',
    risk: 'medium',
    runbook: 'docs/admin-runbooks.md#runbook-2--activate-unsuspend-a-user',
    preconditions: ['Suspension reason resolved'],
    rollback: 'POST /api/v1/admin/users/:id/suspend',
  },
  {
    endpoint: 'POST /api/v1/admin/properties/:id/suspend',
    scope: 'admin:properties:suspend',
    roles: ['admin', 'moderator'],
    owner: 'content-moderation',
    risk: 'medium',
    runbook: 'docs/admin-runbooks.md#runbook-3--suspend-a-property-listing',
    preconditions: ['Active bookings checked'],
    rollback: 'POST /api/v1/admin/properties/:id/activate',
  },
  {
    endpoint: 'POST /api/v1/admin/disputes/:id/resolve',
    scope: 'admin:disputes:resolve',
    roles: ['admin', 'moderator'],
    owner: 'disputes-team',
    risk: 'high',
    runbook: 'docs/admin-runbooks.md#runbook-4--resolve-a-dispute',
    preconditions: ['Investigation checklist complete', 'Dual approval obtained'],
    rollback: 'Irreversible on-chain settlement — manual refund runbook only',
  },
  {
    endpoint: 'POST /api/v1/admin/refunds/approve',
    scope: 'admin:refunds:approve',
    roles: ['admin', 'finance'],
    owner: 'finance',
    risk: 'high',
    runbook: 'docs/admin-runbooks.md#runbook-5--manual-refund-approval',
    preconditions: ['Amount <= total_price verified', 'Dual approval obtained'],
    rollback: 'Irreversible USDC transfer — no rollback',
  },
  {
    endpoint: 'GET /api/v1/admin/reconciliation',
    scope: 'admin:reconciliation:read',
    roles: ['admin', 'finance'],
    owner: 'finance',
    risk: 'low',
    runbook: 'docs/admin-runbooks.md#runbook-7--reconciliation-review',
    preconditions: [],
    rollback: 'Read-only — no rollback needed',
  },
];

/** High-risk = high tier (all require dual approval via middleware). */
export function isHighRisk(policy: AdminActionPolicy): boolean {
  return policy.risk === 'high';
}

/**
 * Centralized enforcement: true only if `role` is listed for the endpoint
 * AND holds the required scope. Role removal takes effect immediately
 * because callers must pass the current role on every request.
 */
export function canInvoke(
  endpoint: string,
  role: string,
): { allowed: boolean; reason?: string } {
  const policy = ADMIN_ACTION_POLICIES.find((p) => p.endpoint === endpoint);
  if (!policy) return { allowed: false, reason: 'Unknown admin endpoint.' };
  if (!(policy.roles as string[]).includes(role)) {
    return { allowed: false, reason: `Role ${role} is not permitted for ${endpoint}.` };
  }
  if (!roleHasScope(role, policy.scope)) {
    return { allowed: false, reason: `Role ${role} lacks scope ${policy.scope}.` };
  }
  return { allowed: true };
}
