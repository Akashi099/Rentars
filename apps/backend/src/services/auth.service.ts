/**
 * Auth service — wraps Supabase Auth operations.
 *
 * Controllers should call these functions instead of touching Supabase directly.
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Keypair, TransactionBuilder, Networks, BASE_FEE } from '@stellar/stellar-sdk';
import { supabase } from '@/config/supabase.js';
import { env } from '@/config/env.js';
import { AuthError, AuthErrorCode } from '@/types/errors.js';
import { emailService } from './email.service.js';
import { issueRefreshToken } from './refreshToken.service.js';
import { securityLogger } from './logging.service.js';
import { auditLogger } from './auditLogger.service.js';
import { markUserSessionsRevoked } from './sessionRevocation.service.js';
import type { ServiceResponse } from './index.js';

const VERIFICATION_TOKEN_EXPIRES_MINUTES = 24 * 60; // 24 hours

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Minimum wall-clock time for the public password-reset request endpoint.
 * Known and unknown addresses both take at least this long, so response
 * timing does not reveal which addresses have accounts.
 */
export const PASSWORD_RESET_MIN_RESPONSE_MS = 500;

async function padToMinimumDuration(startedAt: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string | undefined;
  created_at: string | undefined;
  role?: string;
}

export interface RegisterResult {
  user: AuthUser;
}

export interface LoginResult {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

export interface WalletChallengeResult {
  challenge: string;
  expiresAt: string;
}

export interface WalletVerifyResult {
  token: string;
  user: AuthUser;
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Register a new user via Supabase Auth.
 *
 * @param email - User's email address.
 * @param password - Plain-text password (Supabase hashes it).
 * @returns ServiceResponse with the created user on success.
 */
export async function registerUser(
  email: string,
  password: string,
): Promise<ServiceResponse<RegisterResult>> {
  if (!email || !password) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Email and password are required',
    );
  }

  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    throw new AuthError(AuthErrorCode.USER_ALREADY_EXISTS, error.message);
  }

  if (!data.user) {
    throw new AuthError(
      AuthErrorCode.USER_NOT_FOUND,
      'Registration failed: no user returned',
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRES_MINUTES * 60 * 1000);

  const { error: upsertError } = await supabase.from('users').upsert({
    id: data.user.id,
    email: data.user.email,
    email_verified: false,
    email_verification_token: tokenHash,
    email_verification_expires_at: expiresAt.toISOString(),
  });

  // Without this row the verification link cannot work, so fail the registration
  // rather than report success for an account whose verification state is unknown.
  if (upsertError) {
    throw new AuthError(AuthErrorCode.USER_NOT_FOUND, 'Registration failed: could not persist account state');
  }

  await emailService.sendVerificationEmail({ to: data.user.email!, token: rawToken });

  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    created_at: data.user.created_at,
  };

  return { success: true, data: { user } };
}

/**
 * Authenticate an existing user and issue a JWT.
 *
 * @param email - User's email address.
 * @param password - Plain-text password.
 * @returns ServiceResponse with a signed JWT and user info on success.
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<ServiceResponse<LoginResult>> {
  if (!email || !password) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Email and password are required',
    );
  }

  // Normalize to match the canonical form used at registration and password reset
  const normalizedEmail = email.trim().toLowerCase();

  const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });

  if (error) {
    await securityLogger.logAuthEvent('login_failure', undefined, { email: normalizedEmail });
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, error.message);
  }

  if (!data.user) {
    await securityLogger.logAuthEvent('login_failure', undefined, { email: normalizedEmail });
    throw new AuthError(AuthErrorCode.USER_NOT_FOUND, 'Login failed: no user returned');
  }

  // Fetch role from users table (default to 'tenant' if not set)
  const { data: userRow } = await supabase
    .from('users')
    .select('role')
    .eq('id', data.user.id)
    .single();

  const role: string = (userRow as { role?: string } | null)?.role ?? 'tenant';

  // Short-lived access token (15 minutes)
  const token = jwt.sign(
    { userId: data.user.id, role },
    env.JWT_SECRET,
    { expiresIn: '15m' },
  );

  // Long-lived refresh token stored in Redis (7 days)
  const refreshToken = await issueRefreshToken({ userId: data.user.id, role });

  await securityLogger.logAuthEvent('login_success', data.user.id, { email: normalizedEmail });

  const user: AuthUser = {
    id: data.user.id,
    email: data.user.email,
    created_at: data.user.created_at,
    role,
  };

  return { success: true, data: { token, refreshToken, user } };
}

/**
 * Generate a wallet challenge for Stellar address authentication.
 *
 * @param stellarAddress - Stellar public key (G...)
 * @returns ServiceResponse with challenge string and expiration
 */
export async function generateWalletChallenge(
  stellarAddress: string,
): Promise<ServiceResponse<WalletChallengeResult>> {
  if (!stellarAddress) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Stellar address is required',
    );
  }

  // Generate a random challenge
  const challenge = Keypair.random().publicKey();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const { error } = await supabase.from('wallet_challenges').insert({
    stellar_address: stellarAddress,
    challenge,
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      `Failed to generate challenge: ${error.message}`,
    );
  }

  return {
    success: true,
    data: {
      challenge,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

/**
 * Verify a signed wallet challenge and issue JWT.
 *
 * @param stellarAddress - Stellar public key
 * @param challenge - Challenge string
 * @param signature - Signed challenge (base64)
 * @returns ServiceResponse with JWT and user info
 */
export async function verifyWalletChallenge(
  stellarAddress: string,
  challenge: string,
  signature: string,
): Promise<ServiceResponse<WalletVerifyResult>> {
  if (!stellarAddress || !challenge || !signature) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      'Stellar address, challenge, and signature are required',
    );
  }

  // Fetch the challenge from database
  const { data: challengeData, error: fetchError } = await supabase
    .from('wallet_challenges')
    .select('*')
    .eq('stellar_address', stellarAddress)
    .eq('challenge', challenge)
    .single();

  if (fetchError || !challengeData) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Challenge not found or expired');
  }

  const dbChallenge = challengeData as {
    id: string;
    expires_at: string;
    used: boolean;
  };

  // Check expiration — also reject records whose timestamp is missing or non-finite
  // (malformed stored data must not bypass auth)
  const expiryMs = new Date(dbChallenge.expires_at).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs < Date.now()) {
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Challenge has expired');
  }

  // Check if already used
  if (dbChallenge.used) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Challenge has already been used');
  }

  // Verify signature
  try {
    const keypair = Keypair.fromPublicKey(stellarAddress);
    const signatureBuffer = Buffer.from(signature, 'base64');

    const isValid = keypair.verify(Buffer.from(challenge), signatureBuffer);

    if (!isValid) {
      throw new AuthError(
        AuthErrorCode.INVALID_CREDENTIALS,
        'Invalid signature',
      );
    }
  } catch (err) {
    throw new AuthError(
      AuthErrorCode.INVALID_CREDENTIALS,
      `Signature verification failed: ${String(err)}`,
    );
  }

  // Mark challenge as used
  await supabase
    .from('wallet_challenges')
    .update({ used: true })
    .eq('id', dbChallenge.id);

  // Find or create user with this Stellar address
  let { data: userData, error: userError } = await supabase
    .from('users')
    .select('id, email, created_at, role')
    .eq('stellar_address', stellarAddress)
    .single();

  if (userError || !userData) {
    // Create new user with Stellar address
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        stellar_address: stellarAddress,
        email: null,
        password_hash: null,
      })
      .select()
      .single();

    if (createError || !newUser) {
      throw new AuthError(
        AuthErrorCode.USER_NOT_FOUND,
        'Failed to create user',
      );
    }

    userData = newUser as { id: string; email: string | null; created_at: string; role: string | null };
  }

  const role = userData.role || 'tenant';

  // Issue JWT
  const token = jwt.sign(
    { userId: userData.id, role },
    env.JWT_SECRET,
    { expiresIn: '7d' },
  );

  const user: AuthUser = {
    id: userData.id,
    email: userData.email || undefined,
    created_at: userData.created_at,
    role,
  };

  return {
    success: true,
    data: { token, user },
  };
}

// ─── Email verification ───────────────────────────────────────────────────────

/**
 * Verify an email address using a token sent during registration.
 * Tokens expire after 24 hours and cannot be reused.
 * Prior tokens are invalidated after successful use.
 */
export async function verifyEmail(rawToken: string): Promise<ServiceResponse<void>> {
  if (!rawToken) {
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'Verification token is required');
  }

  const tokenHash = hashToken(rawToken);

  const { data: userData, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('email_verification_token', tokenHash)
    .single();

  if (fetchError || !userData) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Invalid or unknown verification token');
  }

  const user = userData as {
    id: string;
    email_verified: boolean;
    email_verification_expires_at: string;
  };

  // Check if already verified
  if (user.email_verified) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Email has already been verified');
  }

  // Check expiration
  if (new Date(user.email_verification_expires_at) < new Date()) {
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Verification token has expired');
  }

  // Claim the token atomically. The conditional update only matches while the
  // token is still stored and the address is unverified, so two concurrent
  // requests carrying the same link cannot both succeed.
  const { data: claimed, error: claimError } = await supabase
    .from('users')
    .update({
      email_verified: true,
      email_verification_token: null,
      email_verification_expires_at: null,
    })
    .eq('id', user.id)
    .eq('email_verification_token', tokenHash)
    .eq('email_verified', false)
    .select('id');

  if (claimError || !claimed || claimed.length === 0) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Verification token has already been used');
  }

  await securityLogger.logAuthEvent('email_verified', user.id);
  await auditLogger.log({
    actorId: user.id,
    action: 'auth.email_verify',
    resourceType: 'auth',
    resourceId: user.id,
    success: true,
  });

  return { success: true };
}

// ─── Password reset ───────────────────────────────────────────────────────────

const RESET_TOKEN_EXPIRES_MINUTES = 60;

/**
 * Request a password reset for the given email.
 * Always returns success to prevent user enumeration — the email is only
 * sent when an account with that address actually exists.
 * Invalidates all prior reset tokens for the user to prevent replay attacks.
 */
export async function requestPasswordReset(
  email: string,
): Promise<ServiceResponse<void>> {
  if (!email) {
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'Email is required');
  }

  const normalizedEmail = email.toLowerCase().trim();
  const startedAt = Date.now();

  try {
    // Indexed lookup. Listing auth users is not used here: it returns a single
    // page, so accounts beyond that page could never receive a reset link.
    const { data: userRow } = await supabase
      .from('users')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (userRow) {
      const userId = (userRow as { id: string }).id;

      // Invalidate prior reset tokens for this user (replay prevention)
      await supabase
        .from('password_reset_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('consumed_at', null);

      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRES_MINUTES * 60 * 1000);

      await supabase.from('password_reset_tokens').insert({
        user_id: userId,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString(),
      });

      // Send without awaiting: delivery latency must not differ between known
      // and unknown addresses. Failures are logged, never surfaced to the caller.
      emailService
        .sendPasswordResetEmail({ to: normalizedEmail, token: rawToken })
        .catch((err: unknown) => {
          console.error('[auth] Password reset email delivery failed:', err);
        });

      await auditLogger.log({
        actorId: userId,
        action: 'auth.password_reset_request',
        resourceType: 'auth',
        resourceId: userId,
        success: true,
      });
    }
  } catch (err) {
    // Swallow and log: a storage failure must not change the public response.
    console.error('[auth] Password reset request failed:', err);
  }

  await padToMinimumDuration(startedAt, PASSWORD_RESET_MIN_RESPONSE_MS);

  // Always return success with same message to prevent email enumeration
  return { success: true };
}

/**
 * Confirm a password reset using the raw token received by email.
 * Validates the token, updates the password, consumes the token, and
 * invalidates existing sessions by updating `sessions_invalidated_at`.
 * Also revokes all refresh tokens to force re-login across all devices.
 */
export async function confirmPasswordReset(
  rawToken: string,
  newPassword: string,
): Promise<ServiceResponse<void>> {
  if (!rawToken || !newPassword) {
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'Token and new password are required');
  }

  const tokenHash = hashToken(rawToken);

  const { data: tokenRow, error: fetchError } = await supabase
    .from('password_reset_tokens')
    .select('*')
    .eq('token_hash', tokenHash)
    .single();

  if (fetchError || !tokenRow) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Invalid or unknown reset token');
  }

  const row = tokenRow as {
    id: string;
    user_id: string;
    expires_at: string;
    consumed_at: string | null;
  };

  if (row.consumed_at) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Reset token has already been used');
  }

  if (new Date(row.expires_at) < new Date()) {
    throw new AuthError(AuthErrorCode.TOKEN_EXPIRED, 'Reset token has expired');
  }

  // Claim the token before touching the password. The conditional update only
  // matches an unconsumed, unexpired row, so concurrent confirmations with the
  // same link cannot both reset the password.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from('password_reset_tokens')
    .update({ consumed_at: nowIso })
    .eq('id', row.id)
    .is('consumed_at', null)
    .gt('expires_at', nowIso)
    .select('id');

  if (claimError || !claimed || claimed.length === 0) {
    throw new AuthError(AuthErrorCode.INVALID_TOKEN, 'Reset token has already been used');
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(row.user_id, {
    password: newPassword,
  });

  if (updateError) {
    // Release the claim so the user can retry with the same link.
    await supabase
      .from('password_reset_tokens')
      .update({ consumed_at: null })
      .eq('id', row.id);
    throw new AuthError(AuthErrorCode.INVALID_CREDENTIALS, updateError.message);
  }

  const revokedAt = new Date();

  // Record the revocation for stateless JWTs. Persisted in the database for
  // audit and in Redis for the per-request guard.
  await supabase
    .from('users')
    .update({ sessions_invalidated_at: revokedAt.toISOString() })
    .eq('id', row.user_id);

  await markUserSessionsRevoked(row.user_id, revokedAt);

  // Invalidate all refresh tokens for this user across all devices
  const { revokeAllUserRefreshTokens } = await import('./refreshToken.service.js');
  await revokeAllUserRefreshTokens(row.user_id);

  await securityLogger.logAuthEvent('password_reset_confirmed', row.user_id);

  // Audit log the password reset
  await auditLogger.log({
    actorId: row.user_id,
    action: 'auth.password_reset_confirm',
    resourceType: 'auth',
    resourceId: row.user_id,
    success: true,
    meta: {
      sessionsInvalidated: true,
      allDevicesLoggedOut: true,
    },
  });

  return { success: true };
}
