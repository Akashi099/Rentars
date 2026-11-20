/**
 * Unit tests for profile service.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockFrom = mock((_: string) => ({}));
const mockSupabase = { from: mockFrom };

mock.module('../../src/config/supabase.js', () => ({ supabase: mockSupabase }));

import {
  getProfile,
  updateProfile,
  updateStellarAddress,
  getPublicProfile,
  computeProfileCompleteness,
  omitProtectedFields,
} from '../../src/services/profile.service.js';
import { updateProfileSchema } from '../../src/validators/profile.validator.js';

// ─────────────────────────────────────────────────────────────────────────────

const mockProfile = {
  user_id: 'u1',
  display_name: 'Alice',
  avatar_url: 'https://example.com/avatar.jpg',
  phone: '+1234567890',
  stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
  verified: true,
};

describe('profile.service', () => {
  beforeEach(() => {
    mockFrom.mockClear();
  });

  // ── getProfile ──────────────────────────────────────────────────────────────

  describe('getProfile', () => {
    it('should return a profile when found', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: mockProfile, error: null })),
          })),
        })),
      }));

      const result = await getProfile('u1');
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Alice');
    });

    it('should return error for empty userId', async () => {
      const result = await getProfile('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID is required');
    });

    it('should return error when profile not found', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'Not found' } })),
          })),
        })),
      }));

      const result = await getProfile('u-nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Profile not found');
    });
  });

  // ── updateProfile ───────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('should update profile successfully', async () => {
      const updated = { ...mockProfile, display_name: 'Bob' };

      mockFrom.mockImplementation(() => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: updated, error: null })),
          })),
        })),
      }));

      const result = await updateProfile('u1', { name: 'Bob' });
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Bob');
    });

    it('should return error for empty userId', async () => {
      const result = await updateProfile('', { name: 'Bob' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID is required');
    });

    it('should return error when no fields provided', async () => {
      const result = await updateProfile('u1', {});
      expect(result.success).toBe(false);
      expect(result.error).toBe('No fields provided for update');
    });

    it('should return error on DB failure', async () => {
      mockFrom.mockImplementation(() => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: null, error: { message: 'Constraint violation' } })),
          })),
        })),
      }));

      const result = await updateProfile('u1', { name: 'Bob' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Constraint violation');
    });
  });

  // ── updateStellarAddress ────────────────────────────────────────────────────

  describe('updateStellarAddress', () => {
    const validAddress = 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3';

    it('should update stellar address successfully', async () => {
      const updated = { ...mockProfile, stellar_address: validAddress };

      mockFrom.mockImplementation(() => ({
        upsert: mock(() => ({
          select: mock(() => ({
            single: mock(async () => ({ data: updated, error: null })),
          })),
        })),
      }));

      const result = await updateStellarAddress('u1', validAddress);
      expect(result.success).toBe(true);
      expect(result.data?.stellar_address).toBe(validAddress);
    });

    it('should return error for empty userId', async () => {
      const result = await updateStellarAddress('', validAddress);
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID is required');
    });

    it('should return error for empty stellar address', async () => {
      const result = await updateStellarAddress('u1', '');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Stellar address is required');
    });
  });

  // ── getPublicProfile ────────────────────────────────────────────────────────

  describe('getPublicProfile', () => {
    it('should return public profile fields only', async () => {
      const publicData = {
        user_id: 'u1',
        display_name: 'Alice',
        avatar_url: 'https://example.com/avatar.jpg',
        stellar_address: mockProfile.stellar_address,
        verified: true,
      };

      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            maybeSingle: mock(async () => ({ data: publicData, error: null })),
          })),
        })),
      }));

      const result = await getPublicProfile('u1');
      expect(result.success).toBe(true);
      expect(result.data?.name).toBe('Alice');
      // Should not include private fields like phone/address
      expect((result.data as any)?.phone).toBeUndefined();
    });

    it('should return error for empty userId', async () => {
      const result = await getPublicProfile('');
      expect(result.success).toBe(false);
      expect(result.error).toBe('User ID is required');
    });

    it('should return error when profile not found', async () => {
      mockFrom.mockImplementation(() => ({
        select: mock(() => ({
          eq: mock(() => ({
            maybeSingle: mock(async () => ({ data: null, error: { message: 'Not found' } })),
          })),
        })),
      }));

      const result = await getPublicProfile('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Profile not found');
    });
  });

  // ── computeProfileCompleteness ───────────────────────────────────────────────

  describe('computeProfileCompleteness', () => {
    it('returns max score for a complete profile', () => {
      const result = computeProfileCompleteness({
        name: 'Alice',
        avatar_url: 'https://example.com/avatar.jpg',
        phone: '+1234567890',
        address: '123 Main St',
        stellar_address: 'GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFSNHERX3LRJCX5FWCL46664F3',
      });
      expect(result.score).toBe(result.maxScore);
      expect(result.missingFields).toHaveLength(0);
    });

    it('returns zero score for an empty profile', () => {
      const result = computeProfileCompleteness({});
      expect(result.score).toBe(0);
      expect(result.missingFields).toHaveLength(4);
    });

    it('counts only non-empty fields', () => {
      const result = computeProfileCompleteness({ name: 'Alice' });
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThan(result.maxScore);
      expect(result.missingFields).not.toContain('name');
    });
  });
});

// ── Partial update and field ownership (#918) ────────────────────────────────

describe('profile partial updates and field ownership (#918)', () => {
  type Captured = { table: string; payload?: Record<string, unknown>; eqs: Array<[string, unknown]> };
  let captured: Captured;

  /** Routes upsert/update to a canned row and records the payload and filters. */
  function stubWrite(result: { data: unknown; error?: unknown }, mode: 'upsert' | 'update' = 'upsert') {
    mockFrom.mockImplementation((table: string) => {
      captured = { table, eqs: [] };
      const chain: Record<string, unknown> = {};
      chain.eq = mock((col: string, val: unknown) => {
        captured.eqs.push([col, val]);
        return chain;
      });
      chain.select = mock(() => chain);
      chain.single = mock(async () => result);
      chain.maybeSingle = mock(async () => result);
      const writer = mock((payload: Record<string, unknown>) => {
        captured.payload = payload;
        return chain;
      });
      if (mode === 'upsert') chain.upsert = writer;
      else chain.update = writer;
      return chain;
    });
  }

  beforeEach(() => mockFrom.mockClear());

  it('writes only the provided fields and maps name to display_name', async () => {
    stubWrite({ data: { ...mockProfile, display_name: 'Bob' } });

    const result = await updateProfile('u1', { name: 'Bob' });

    expect(result.success).toBe(true);
    expect(captured.payload).toMatchObject({ display_name: 'Bob', user_id: 'u1' });
    expect(captured.payload).not.toHaveProperty('phone');
    expect(captured.payload).not.toHaveProperty('avatar_url');
    expect(captured.payload).not.toHaveProperty('name');
    expect(typeof captured.payload?.updated_at).toBe('string');
  });

  it('clears an optional field only when it is explicitly null', async () => {
    stubWrite({ data: { ...mockProfile, phone: null } });

    await updateProfile('u1', { phone: null });

    expect(captured.payload).toMatchObject({ phone: null });
  });

  it('drops server-owned and unknown keys before writing', async () => {
    stubWrite({ data: mockProfile });

    await updateProfile('u1', { name: 'Eve', role: 'admin', verified: true, status: 'active', address: 'x' } as Record<string, unknown>);

    expect(captured.payload).not.toHaveProperty('role');
    expect(captured.payload).not.toHaveProperty('verified');
    expect(captured.payload).not.toHaveProperty('status');
    expect(captured.payload).not.toHaveProperty('address');
  });

  it('applies the concurrency precondition on updated_at and returns CONFLICT with the current profile', async () => {
    // First maybeSingle (guarded update) finds no row; the follow-up read finds the current one.
    let call = 0;
    mockFrom.mockImplementation(() => {
      call += 1;
      const chain: Record<string, unknown> = {};
      chain.eq = mock((col: string, val: unknown) => {
        if (call === 1) captured = { table: 'profiles', eqs: [[col, val]] };
        else captured?.eqs.push([col, val]);
        return chain;
      });
      chain.select = mock(() => chain);
      chain.update = mock((payload: Record<string, unknown>) => {
        captured = { ...(captured ?? { table: 'profiles', eqs: [] }), payload };
        return chain;
      });
      chain.maybeSingle = mock(async () => (call === 1 ? { data: null, error: null } : { data: mockProfile, error: null }));
      chain.single = mock(async () => ({ data: mockProfile, error: null }));
      return chain;
    });

    const result = await updateProfile('u1', { name: 'Bob' }, { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CONFLICT');
    expect(result.current?.name).toBe('Alice');
    expect(captured.eqs).toContainEqual(['updated_at', '2026-01-01T00:00:00.000Z']);
  });

  it('returns the canonical row after a successful guarded update', async () => {
    stubWrite({ data: { ...mockProfile, display_name: 'Bob' } }, 'update');

    const result = await updateProfile('u1', { name: 'Bob' }, { expectedUpdatedAt: '2026-01-01T00:00:00.000Z' });

    expect(result.success).toBe(true);
    expect(result.data?.name).toBe('Bob');
    expect(captured.eqs).toContainEqual(['updated_at', '2026-01-01T00:00:00.000Z']);
  });

  it('public profile never exposes phone or bio even if the row carries them', async () => {
    mockFrom.mockImplementation(() => ({
      select: mock((cols: string) => {
        // The public query must not even ask for private columns.
        expect(cols).not.toMatch(/phone|bio/);
        return {
          eq: mock(() => ({
            maybeSingle: mock(async () => ({
              data: { ...mockProfile, bio: 'private bio' },
              error: null,
            })),
          })),
        };
      }),
    }));

    const result = await getPublicProfile('u1');
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('phone');
    expect(result.data).not.toHaveProperty('bio');
    expect(result.data?.verification_status).toBe('verified');
  });

  it('rejects a whitespace-only name instead of storing an empty one', () => {
    expect(updateProfileSchema.safeParse({ name: '   ' }).success).toBe(false);
    const ok = updateProfileSchema.parse({ name: '  Bob  ' });
    expect(ok.name).toBe('Bob');
  });

  it('requires at least one real field, not just the concurrency token', () => {
    expect(updateProfileSchema.safeParse({ expected_updated_at: '2026-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(
      updateProfileSchema.safeParse({ name: 'Bob', expected_updated_at: '2026-01-01T00:00:00.000Z' }).success,
    ).toBe(true);
  });

  it('accepts explicit nulls for clearable fields', () => {
    const parsed = updateProfileSchema.parse({ phone: null, avatar_url: null, stellar_address: null });
    expect(parsed).toMatchObject({ phone: null, avatar_url: null, stellar_address: null });
  });

  it('omitProtectedFields keeps ordinary profile fields', () => {
    expect(omitProtectedFields({ name: 'A', role: 'admin', phone: '1' })).toEqual({ name: 'A', phone: '1' });
  });
});
