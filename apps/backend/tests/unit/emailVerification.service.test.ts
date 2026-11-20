import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── Supabase mock ─────────────────────────────────────────────────────────────

const mockAuthSignUp = mock(async () => ({ data: null, error: null }));
const mockFromSelect = mock(() => ({}));
const mockFromInsert = mock(async () => ({ data: {}, error: null }));
const mockFromUpsert = mock(async () => ({ data: {}, error: null }));
const mockFromUpdate = mock(() => ({}));

const mockSupabase = {
  auth: { signUp: mockAuthSignUp },
  from: mock((_: string) => ({
    select: mockFromSelect,
    insert: mockFromInsert,
    upsert: mockFromUpsert,
    update: mockFromUpdate,
  })),
};

// Module-level replacement via mock.module: assigning onto an imported ESM
// namespace throws in Bun 1.1.38.
mock.module('../../src/config/supabase.js', () => ({ supabase: mockSupabase }));

// ── Email mock ────────────────────────────────────────────────────────────────

const mockSendVerificationEmail = mock(async () => {});
mock.module('../../src/services/email.service.js', () => ({
  emailService: { sendVerificationEmail: mockSendVerificationEmail },
}));

const { verifyEmail, resendVerification } = await import('../../src/services/auth.service.js');
const { AuthError } = await import('../../src/types/errors.js');

// ─────────────────────────────────────────────────────────────────────────────

const FUTURE_EXPIRY = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const PAST_EXPIRY = new Date(Date.now() - 1000).toISOString();

describe('verifyEmail', () => {
  beforeEach(() => {
    mockSendVerificationEmail.mockClear();
  });

  it('marks account as verified for a valid token', async () => {
    const mockUpdateEq = mock(() => ({
      eq: mock(() => ({
        eq: mock(() => ({ select: mock(async () => ({ data: [{ id: 'u1' }], error: null })) })),
      })),
    }));
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { id: 'u1', email_verified: false, email_verification_expires_at: FUTURE_EXPIRY },
            error: null,
          })),
        })),
      })),
      // Conditional claim: id, stored token hash and unverified state must all still match.
      update: mock(() => ({ eq: mockUpdateEq })),
    })) as any;

    const result = await verifyEmail('somerawtoken');
    expect(result.success).toBe(true);
    expect(mockUpdateEq).toHaveBeenCalled();
  });

  it('returns success immediately if already verified (idempotent)', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { id: 'u1', email_verified: true, email_verification_expires_at: FUTURE_EXPIRY },
            error: null,
          })),
        })),
      })),
    })) as any;

    const result = await verifyEmail('sometoken');
    expect(result.success).toBe(true);
  });

  it('throws on expired token', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { id: 'u1', email_verified: false, email_verification_expires_at: PAST_EXPIRY },
            error: null,
          })),
        })),
      })),
    })) as any;

    let thrown = false;
    try {
      await verifyEmail('expiredtoken');
    } catch (err) {
      thrown = true;
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toMatch(/expired/);
    }
    expect(thrown).toBe(true);
  });

  it('throws on invalid / unknown token', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: null, error: { message: 'no rows' } })),
        })),
      })),
    })) as any;

    let thrown = false;
    try {
      await verifyEmail('badtoken');
    } catch (err) {
      thrown = true;
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toMatch(/Invalid/);
    }
    expect(thrown).toBe(true);
  });

  it('throws when token is empty', async () => {
    let thrown = false;
    try {
      await verifyEmail('');
    } catch (err) {
      thrown = true;
      expect(err).toBeInstanceOf(AuthError);
    }
    expect(thrown).toBe(true);
  });
});

describe('resendVerification', () => {
  beforeEach(() => {
    mockSendVerificationEmail.mockClear();
  });

  it('sends a new verification email for an unverified account', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { id: 'u1', email_verified: false },
            error: null,
          })),
        })),
      })),
      update: mock(() => ({ eq: mock(async () => ({})) })),
    })) as any;

    await resendVerification('user@example.com');
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('does not send email if account does not exist (enumeration resistance)', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({ data: null, error: { message: 'no rows' } })),
        })),
      })),
    })) as any;

    const result = await resendVerification('ghost@example.com');
    expect(result.success).toBe(true);
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('does not send email if account is already verified', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { id: 'u1', email_verified: true },
            error: null,
          })),
        })),
      })),
    })) as any;

    await resendVerification('verified@example.com');
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('booking/listing guard — unverified account', () => {
  it('requireEmailVerified responds 403 when email_verified is false', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { email_verified: false },
            error: null,
          })),
        })),
      })),
    })) as any;

    const { requireEmailVerified } = await import('../../src/middleware/emailVerified.middleware.js');

    let statusCode = 0;
    let body: unknown = null;
    const req = { userId: 'u1' } as any;
    const res = {
      status: (code: number) => { statusCode = code; return res; },
      json: (b: unknown) => { body = b; },
    } as any;
    const next = mock(() => {});

    await requireEmailVerified(req, res, next);

    expect(statusCode).toBe(403);
    expect((body as any).error).toMatch(/verification/i);
    expect(next).not.toHaveBeenCalled();
  });

  it('requireEmailVerified calls next when email_verified is true', async () => {
    mockSupabase.from = mock((_: string) => ({
      select: mock(() => ({
        eq: mock(() => ({
          single: mock(async () => ({
            data: { email_verified: true },
            error: null,
          })),
        })),
      })),
    })) as any;

    const { requireEmailVerified } = await import('../../src/middleware/emailVerified.middleware.js');

    const req = { userId: 'u1' } as any;
    const res = {} as any;
    const next = mock(() => {});

    await requireEmailVerified(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
