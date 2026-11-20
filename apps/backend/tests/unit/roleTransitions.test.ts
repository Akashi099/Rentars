/**
 * Pure policy tests for role transitions (#916).
 */
import { describe, expect, it } from 'bun:test';
import { evaluateRoleTransition, isAssignableRole } from '../../src/config/roleTransitions.js';

const base = { actorRole: 'admin', actorId: 'admin-1', targetId: 'user-2', adminCount: 2 };

describe('evaluateRoleTransition', () => {
  it('allows an admin to promote a tenant to host', () => {
    expect(evaluateRoleTransition({ ...base, fromRole: 'tenant', toRole: 'host' })).toEqual({
      allowed: true,
    });
  });

  it('allows an admin to grant a privileged role from a non-privileged one', () => {
    expect(evaluateRoleTransition({ ...base, fromRole: 'host', toRole: 'moderator' })).toEqual({
      allowed: true,
    });
  });

  it('refuses when the actor is not an admin, even for a legitimate-looking change', () => {
    const r = evaluateRoleTransition({
      ...base,
      actorRole: 'moderator',
      fromRole: 'tenant',
      toRole: 'host',
    });
    expect(r).toMatchObject({ allowed: false, code: 'ACTOR_NOT_ADMIN' });
  });

  it('refuses a missing actor role', () => {
    const r = evaluateRoleTransition({
      ...base,
      actorRole: undefined,
      fromRole: 'tenant',
      toRole: 'host',
    });
    expect(r).toMatchObject({ allowed: false, code: 'ACTOR_NOT_ADMIN' });
  });

  it('refuses self-promotion and self-demotion', () => {
    const up = evaluateRoleTransition({
      ...base,
      targetId: 'admin-1',
      fromRole: 'tenant',
      toRole: 'admin',
    });
    const down = evaluateRoleTransition({
      ...base,
      targetId: 'admin-1',
      fromRole: 'admin',
      toRole: 'tenant',
      adminCount: 5,
    });
    expect(up).toMatchObject({ allowed: false, code: 'SELF_ROLE_CHANGE' });
    expect(down).toMatchObject({ allowed: false, code: 'SELF_ROLE_CHANGE' });
  });

  it('refuses a direct move between two privileged roles', () => {
    const r = evaluateRoleTransition({ ...base, fromRole: 'moderator', toRole: 'finance' });
    expect(r).toMatchObject({ allowed: false, code: 'PRIVILEGED_TO_PRIVILEGED' });
  });

  it('refuses demotion of the last admin', () => {
    const r = evaluateRoleTransition({
      ...base,
      fromRole: 'admin',
      toRole: 'tenant',
      adminCount: 1,
    });
    expect(r).toMatchObject({ allowed: false, code: 'LAST_ADMIN' });
  });

  it('allows demotion of an admin when another admin exists', () => {
    expect(
      evaluateRoleTransition({ ...base, fromRole: 'admin', toRole: 'tenant', adminCount: 2 })
    ).toEqual({ allowed: true });
  });

  it('refuses a no-op change', () => {
    expect(evaluateRoleTransition({ ...base, fromRole: 'host', toRole: 'host' })).toMatchObject({
      code: 'NO_CHANGE',
    });
  });

  it.each(['both', 'superuser', '', 'ADMIN', null, undefined, 42])(
    'refuses unknown target role %p',
    (toRole) => {
      expect(evaluateRoleTransition({ ...base, fromRole: 'tenant', toRole })).toMatchObject({
        allowed: false,
        code: 'UNKNOWN_ROLE',
      });
    }
  );

  it('refuses when the stored current role is unrecognised', () => {
    expect(evaluateRoleTransition({ ...base, fromRole: 'legacy', toRole: 'host' })).toMatchObject({
      code: 'UNKNOWN_ROLE',
    });
  });
});

describe('isAssignableRole', () => {
  it('accepts only roles the database constraint allows', () => {
    expect(isAssignableRole('finance')).toBe(true);
    expect(isAssignableRole('both')).toBe(false);
  });
});

// ── Profile update cannot carry privilege fields (#916) ──────────────────────
import { updateProfileSchema } from '../../src/validators/profile.validator.js';

describe('updateProfileSchema ignores privilege fields', () => {
  it.each([
    { name: 'Eve', role: 'admin' },
    { name: 'Eve', user_id: 'someone-else' },
    { name: 'Eve', verification_status: 'verified' },
  ])('drops forged keys from %j', (body) => {
    const parsed = updateProfileSchema.parse(body);
    expect(parsed).not.toHaveProperty('role');
    expect(parsed).not.toHaveProperty('user_id');
    expect(parsed).not.toHaveProperty('verification_status');
  });
});
