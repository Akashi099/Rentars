/**
 * Admin Scope Definitions
 *
 * Every admin action requires a specific scope. Scopes follow the principle
 * of least privilege: a "moderator" can manage content and disputes but
 * cannot touch financial records or irreversible user actions.
 *
 * ROLE → SCOPES mapping:
 *
 *   admin       — all scopes (full platform access)
 *   moderator   — content moderation, dispute management, search analytics
 *   support     — read-only user/booking/property lookup, rate-limit summary
 *   finance     — refund approvals, reconciliation (dual-approval required)
 *
 * The JWT `role` claim carries one of: "admin" | "moderator" | "support" | "finance".
 * Sub-roles are additive: a user can only have one role.
 *
 * HIGH-RISK actions (DUAL_APPROVAL_REQUIRED) additionally require an
 * `X-Approval-Actor` header containing the ID of a second admin who has
 * pre-approved the action out-of-band. The approving actor must be different
 * from the requesting actor and must hold a role with the same scope.
 */

// ── Scope identifiers ─────────────────────────────────────────────────────────

export type AdminScope =
  // Dashboard & analytics
  | 'admin:dashboard:read'
  | 'admin:analytics:read'
  // User management
  | 'admin:users:read'
  | 'admin:users:suspend'      // HIGH-RISK: irreversible user impact
  | 'admin:users:activate'
  // Property management
  | 'admin:properties:read'
  | 'admin:properties:suspend'
  | 'admin:properties:activate'
  | 'admin:properties:feature'
  // Booking management
  | 'admin:bookings:read'
  // Dispute management
  | 'admin:disputes:read'
  | 'admin:disputes:resolve'   // HIGH-RISK: financial settlement
  // Audit logs
  | 'admin:audit:read'
  // Rate limits
  | 'admin:ratelimits:read'
  // Refund / financial
  | 'admin:refunds:approve'    // HIGH-RISK: financial action, dual-approval required
  | 'admin:reconciliation:read'
  // Email delivery tracking (added: feature 1)
  | 'admin:email:read'
  // Notification monitoring (added: feature 2)
  | 'admin:notifications:read'
  // Abuse reports (added: feature 4)
  | 'admin:abuse:read';

// ── Scopes that require dual approval ────────────────────────────────────────

export const DUAL_APPROVAL_REQUIRED = new Set<AdminScope>([
  'admin:disputes:resolve',
  'admin:refunds:approve',
  'admin:users:suspend',
]);

// ── Role → Scope mapping ──────────────────────────────────────────────────────

export type AdminRole = 'admin' | 'moderator' | 'support' | 'finance';

export const ROLE_SCOPES: Record<AdminRole, AdminScope[]> = {
  admin: [
    'admin:dashboard:read',
    'admin:analytics:read',
    'admin:users:read',
    'admin:users:suspend',
    'admin:users:activate',
    'admin:properties:read',
    'admin:properties:suspend',
    'admin:properties:activate',
    'admin:properties:feature',
    'admin:bookings:read',
    'admin:disputes:read',
    'admin:disputes:resolve',
    'admin:audit:read',
    'admin:ratelimits:read',
    'admin:refunds:approve',
    'admin:reconciliation:read',
    'admin:email:read',
    'admin:notifications:read',
    'admin:abuse:read',
  ],
  moderator: [
    'admin:dashboard:read',
    'admin:analytics:read',
    'admin:users:read',
    'admin:properties:read',
    'admin:properties:suspend',
    'admin:properties:activate',
    'admin:properties:feature',
    'admin:bookings:read',
    'admin:disputes:read',
    'admin:disputes:resolve',
    'admin:audit:read',
    'admin:notifications:read',
    'admin:abuse:read',
  ],
  support: [
    'admin:users:read',
    'admin:properties:read',
    'admin:bookings:read',
    'admin:disputes:read',
    'admin:ratelimits:read',
    'admin:audit:read',
    'admin:abuse:read',
  ],
  finance: [
    'admin:bookings:read',
    'admin:disputes:read',
    'admin:refunds:approve',
    'admin:reconciliation:read',
    'admin:audit:read',
  ],
};

/**
 * Returns true if the given role has the requested scope.
 */
export function roleHasScope(role: string, scope: AdminScope): boolean {
  const known = role as AdminRole;
  if (!(known in ROLE_SCOPES)) return false;
  return ROLE_SCOPES[known].includes(scope);
}
