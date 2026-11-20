/**
 * Role-transition policy for user role changes (#916).
 *
 * The server is the only authority for `users.role`. This module is a pure
 * policy: it decides whether a proposed change is allowed, given the actor's
 * server-side role and whether the actor is changing their own account.
 * Persistence and auditing live in roleAssignment.service.ts.
 *
 * Matrix (actor must be `admin`; checked against the database, not the JWT):
 *
 *   from \ to      | tenant | host | admin | moderator | support | finance
 *   tenant         |   -    |  ✓   |   ✓   |     ✓     |    ✓    |    ✓
 *   host           |   ✓    |  -   |   ✓   |     ✓     |    ✓    |    ✓
 *   admin          |   ✓    |  ✓   |   -   |     ✗     |    ✗    |    ✗
 *   moderator      |   ✓    |  ✓   |   ✗   |     -     |    ✗    |    ✗
 *   support        |   ✓    |  ✓   |   ✗   |     ✗     |    -    |    ✗
 *   finance        |   ✓    |  ✓   |   ✗   |     ✗     |    ✗    |    -
 *
 * Privileged roles can only be granted or removed by moving through a
 * non-privileged role, which keeps every privilege change a deliberate,
 * separately-audited step. Self-changes are always refused, and the last
 * remaining admin cannot be demoted.
 *
 * The DB `users_role_check` constraint (migration 00057) is the storage-level
 * allow-list. `both` from the web type is not stored by the backend.
 */

export const ASSIGNABLE_ROLES = [
  'tenant',
  'host',
  'admin',
  'moderator',
  'support',
  'finance',
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const UNPRIVILEGED_ROLES: readonly AssignableRole[] = ['tenant', 'host'];
export const PRIVILEGED_ROLES: readonly AssignableRole[] = [
  'admin',
  'moderator',
  'support',
  'finance',
];

export type RoleTransitionDenial =
  | 'ACTOR_NOT_ADMIN'
  | 'SELF_ROLE_CHANGE'
  | 'UNKNOWN_ROLE'
  | 'NO_CHANGE'
  | 'PRIVILEGED_TO_PRIVILEGED'
  | 'LAST_ADMIN';

export type RoleTransitionDecision =
  | { allowed: true }
  | { allowed: false; code: RoleTransitionDenial; message: string };

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

export interface RoleTransitionInput {
  actorRole: string | null | undefined;
  actorId: string;
  targetId: string;
  fromRole: string | null | undefined;
  toRole: unknown;
  /** Number of accounts currently holding the `admin` role. */
  adminCount: number;
}

/**
 * Decide whether `fromRole` -> `toRole` is allowed for this actor.
 * Pure function: no I/O, no environment reads.
 */
export function evaluateRoleTransition(input: RoleTransitionInput): RoleTransitionDecision {
  if (input.actorRole !== 'admin') {
    return {
      allowed: false,
      code: 'ACTOR_NOT_ADMIN',
      message: 'Only administrators can change roles.',
    };
  }
  if (input.actorId === input.targetId) {
    return {
      allowed: false,
      code: 'SELF_ROLE_CHANGE',
      message: 'You cannot change your own role.',
    };
  }
  if (!isAssignableRole(input.toRole) || !isAssignableRole(input.fromRole)) {
    return { allowed: false, code: 'UNKNOWN_ROLE', message: 'Unknown role.' };
  }
  const from = input.fromRole;
  const to = input.toRole;
  if (from === to) {
    return { allowed: false, code: 'NO_CHANGE', message: 'User already has this role.' };
  }
  const fromPriv = (PRIVILEGED_ROLES as readonly string[]).includes(from);
  const toPriv = (PRIVILEGED_ROLES as readonly string[]).includes(to);
  if (fromPriv && toPriv) {
    return {
      allowed: false,
      code: 'PRIVILEGED_TO_PRIVILEGED',
      message: 'Change this user to a non-privileged role first, then to the new role.',
    };
  }
  if (from === 'admin' && input.adminCount <= 1) {
    return {
      allowed: false,
      code: 'LAST_ADMIN',
      message: 'The last administrator cannot be demoted.',
    };
  }
  return { allowed: true };
}
