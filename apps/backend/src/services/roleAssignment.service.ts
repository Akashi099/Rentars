/**
 * Server-side role assignment (#916).
 *
 * Every role change goes through `changeUserRole`, which:
 *  1. re-reads the actor's role from the database (a JWT role claim can be stale),
 *  2. evaluates the transition matrix in config/roleTransitions.ts,
 *  3. writes with a compare-and-set on the previous role, so a concurrent
 *     change cannot be silently overwritten,
 *  4. records an audit event for allowed AND denied attempts, with actor,
 *     target, old role, new role, and the request correlation ID. No tokens
 *     or secrets are written.
 */

import {
  type AssignableRole,
  type RoleTransitionDenial,
  evaluateRoleTransition,
} from '@/config/roleTransitions.js';
import { supabase } from '@/config/supabase.js';
import { auditLogger } from '@/services/auditLogger.service.js';

export type ChangeRoleResult =
  | { ok: true; userId: string; oldRole: string; newRole: AssignableRole }
  | {
      ok: false;
      status: 403 | 404 | 409 | 422 | 500;
      code: RoleTransitionDenial | 'NOT_FOUND' | 'CONCURRENT_UPDATE' | 'DB_ERROR';
      message: string;
    };

export interface ChangeRoleParams {
  actorId: string;
  targetId: string;
  toRole: AssignableRole;
  requestId?: string;
  ip?: string;
}

const STATUS_BY_CODE: Partial<Record<RoleTransitionDenial, 403 | 409 | 422>> = {
  ACTOR_NOT_ADMIN: 403,
  SELF_ROLE_CHANGE: 403,
  UNKNOWN_ROLE: 422,
  NO_CHANGE: 409,
  PRIVILEGED_TO_PRIVILEGED: 409,
  LAST_ADMIN: 409,
};

export async function changeUserRole(params: ChangeRoleParams): Promise<ChangeRoleResult> {
  const { actorId, targetId, toRole, requestId, ip } = params;

  const { data: actor, error: actorErr } = await supabase
    .from('users')
    .select('role')
    .eq('id', actorId)
    .maybeSingle();
  if (actorErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Could not verify actor.' };
  }

  const { data: target, error: targetErr } = await supabase
    .from('users')
    .select('id, role')
    .eq('id', targetId)
    .maybeSingle();
  if (targetErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Could not load target user.' };
  }
  if (!target) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'User not found.' };
  }

  const { count: adminCount } = await supabase
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'admin');

  const decision = evaluateRoleTransition({
    actorRole: (actor as { role?: string } | null)?.role ?? null,
    actorId,
    targetId,
    fromRole: target.role,
    toRole,
    adminCount: adminCount ?? 0,
  });

  const auditBase = {
    actorId,
    action: 'admin.user_role_change' as const,
    resourceType: 'user' as const,
    resourceId: targetId,
    correlationId: requestId,
    ip,
  };

  if (!decision.allowed) {
    await auditLogger.log({
      ...auditBase,
      action: 'admin.user_role_change_denied',
      success: false,
      error: decision.code,
      meta: { old_role: target.role, new_role: toRole, reason: decision.code },
    });
    return {
      ok: false,
      status: STATUS_BY_CODE[decision.code] ?? 403,
      code: decision.code,
      message: decision.message,
    };
  }

  // Compare-and-set: the update only applies if the role is still what we read.
  const { data: updated, error: updateErr } = await supabase
    .from('users')
    .update({ role: toRole })
    .eq('id', targetId)
    .eq('role', target.role)
    .select('id')
    .maybeSingle();

  if (updateErr) {
    return { ok: false, status: 500, code: 'DB_ERROR', message: 'Role update failed.' };
  }
  if (!updated) {
    return {
      ok: false,
      status: 409,
      code: 'CONCURRENT_UPDATE',
      message: 'The user role changed while this request was processing. Reload and try again.',
    };
  }

  await auditLogger.log({
    ...auditBase,
    success: true,
    meta: { old_role: target.role, new_role: toRole },
  });

  return { ok: true, userId: targetId, oldRole: target.role, newRole: toRole };
}
