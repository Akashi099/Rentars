import { randomBytes } from 'node:crypto';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { supabase } from '@/config/supabase.js';
import { getJwtSecret } from '@/config/jwtSecret.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';
import type { AuditAction } from './auditLogger.service.js';

/**
 * Wallet proof-of-possession and account linking.
 *
 * Every challenge is bound on the server to:
 *   - a purpose (`login`, `link`, `unlink`), so a login proof cannot authorise a link;
 *   - a user, for link and unlink, so a proof cannot be used on another account;
 *   - the Stellar network it was issued for;
 *   - a short expiry, and single use (the row is deleted when consumed).
 * The client signs the challenge string itself, so the signature proves control of
 * the address; the binding above is enforced from the stored row.
 */

export type WalletChallengePurpose = 'login' | 'link' | 'unlink';

export interface ChallengeResponse {
  challenge: string;
}

export interface VerifyResponse {
  /** Session token. Present for login; link and unlink return only the address. */
  token?: string;
  address: string;
  userId?: string;
}

export interface ChallengeOptions {
  purpose?: WalletChallengePurpose;
  /** Required for link and unlink. The authenticated account the challenge is bound to. */
  userId?: string;
}

const CHALLENGE_EXPIRY = 5 * 60 * 1000; // 5 minutes

/** Network passphrase a challenge is bound to. Overridable for tests and non-default deployments. */
export function getWalletNetworkPassphrase(): string {
  if (process.env.STELLAR_NETWORK_PASSPHRASE) return process.env.STELLAR_NETWORK_PASSPHRASE;
  return process.env.STELLAR_NETWORK === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

function fail<T = never>(error: string, statusCode: number, code: string): ServiceResponse<T> {
  return { success: false, error, statusCode, code };
}

export class WalletAuthService {
  /**
   * Find the account that currently owns a wallet address, if any.
   * Returns the user id or null.
   */
  async findOwnerId(address: string): Promise<string | null> {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('stellar_address', address)
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  }

  async generateChallenge(
    address: string,
    options: ChallengeOptions = {},
  ): Promise<ServiceResponse<ChallengeResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return fail('Invalid Stellar address', 400, 'INVALID_ADDRESS');
    }

    const purpose = options.purpose ?? 'login';
    if (purpose !== 'login' && !options.userId) {
      return fail('Authentication required', 401, 'UNAUTHORIZED');
    }

    try {
      if (purpose === 'link') {
        const owner = await this.findOwnerId(address);
        if (owner && owner !== options.userId) {
          return fail('This wallet is already linked to another account', 409, 'WALLET_ALREADY_LINKED');
        }
      }

      if (purpose === 'unlink') {
        const owner = await this.findOwnerId(address);
        if (owner !== options.userId) {
          return fail('This wallet is not linked to your account', 409, 'WALLET_NOT_LINKED');
        }
      }

      // 256 bits of randomness, single use (consumed in verifySignature).
      const challenge = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY);

      const { error } = await supabase.from('wallet_challenges').insert({
        address,
        challenge,
        expires_at: expiresAt.toISOString(),
        purpose,
        user_id: options.userId ?? null,
        network: getWalletNetworkPassphrase(),
      });

      if (error) {
        return fail('Failed to generate challenge', 500, 'CHALLENGE_STORE_FAILED');
      }

      return { success: true, data: { challenge } };
    } catch (err) {
      return fail('Challenge generation failed', 500, 'CHALLENGE_FAILED');
    }
  }

  /**
   * Verify a signed challenge for the given purpose.
   *
   * The challenge is consumed atomically with its binding filters before the
   * signature is checked, so a failed attempt cannot be retried and a replay
   * finds no row.
   */
  async verifySignature(
    address: string,
    challenge: string,
    signature: string,
    options: ChallengeOptions = {},
  ): Promise<ServiceResponse<VerifyResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return fail('Invalid Stellar address', 400, 'INVALID_ADDRESS');
    }

    const purpose = options.purpose ?? 'login';
    if (purpose !== 'login' && !options.userId) {
      return fail('Authentication required', 401, 'UNAUTHORIZED');
    }

    try {
      let consume = supabase
        .from('wallet_challenges')
        .delete()
        .eq('address', address)
        .eq('challenge', challenge)
        .eq('purpose', purpose)
        .gt('expires_at', new Date().toISOString());

      if (purpose !== 'login') {
        consume = consume.eq('user_id', options.userId as string);
      }

      const { data: consumed, error: consumeError } = await consume.select('id, network');

      if (consumeError || !consumed || consumed.length === 0) {
        return fail('Challenge not found or expired', 401, 'CHALLENGE_INVALID');
      }

      const [row] = consumed as Array<{ id: string; network: string | null }>;
      if (row.network && row.network !== getWalletNetworkPassphrase()) {
        return fail('Challenge was issued for a different network', 401, 'NETWORK_MISMATCH');
      }

      try {
        const keypair = Keypair.fromPublicKey(address);
        const signatureBuffer = Buffer.from(signature, 'base64');
        if (!keypair.verify(Buffer.from(challenge), signatureBuffer)) {
          return fail('Invalid signature', 401, 'INVALID_SIGNATURE');
        }
      } catch {
        return fail('Invalid signature', 401, 'INVALID_SIGNATURE');
      }

      if (purpose === 'link') return this.linkWallet(options.userId as string, address);
      if (purpose === 'unlink') return this.unlinkWallet(options.userId as string, address);
      return this.loginWithWallet(address);
    } catch (err) {
      return fail('Verification failed', 500, 'VERIFICATION_FAILED');
    }
  }

  /** Sign-in with a verified wallet. Resolves the same account record that email sign-in uses. */
  private async loginWithWallet(address: string): Promise<ServiceResponse<VerifyResponse>> {
    let userRow = await this.findUserByAddress(address);

    if (!userRow) {
      const { data: created, error: createError } = await supabase
        .from('users')
        .insert({ stellar_address: address, email: null, password_hash: null })
        .select('id, role')
        .single();

      if (createError || !created) {
        // A concurrent login may have created the account first; the unique index
        // makes that the only way this insert fails for a verified address.
        userRow = await this.findUserByAddress(address);
        if (!userRow) return fail('Failed to create user', 500, 'USER_CREATE_FAILED');
      } else {
        userRow = created as { id: string; role: string | null };
      }
    }

    const role = userRow.role || 'tenant';
    const token = jwt.sign({ userId: userRow.id, role, address }, getJwtSecret(), { expiresIn: '24h' });

    // Keep the profile keyed by address in sync for the profile screens.
    const { error: profileError } = await supabase.from('profiles').upsert({
      stellar_address: address,
      updated_at: new Date().toISOString(),
    });

    if (profileError) {
      return fail('Failed to create user profile', 500, 'PROFILE_FAILED');
    }

    return { success: true, data: { token, address, userId: userRow.id } };
  }

  private async findUserByAddress(address: string): Promise<{ id: string; role: string | null } | null> {
    const { data } = await supabase
      .from('users')
      .select('id, role')
      .eq('stellar_address', address)
      .maybeSingle();
    return (data as { id: string; role: string | null } | null) ?? null;
  }

  /** Link a verified wallet to the authenticated account. One wallet per account. */
  private async linkWallet(userId: string, address: string): Promise<ServiceResponse<VerifyResponse>> {
    const { data: current } = await supabase
      .from('users')
      .select('id, stellar_address')
      .eq('id', userId)
      .single();

    const currentAddress = (current as { stellar_address: string | null } | null)?.stellar_address ?? null;
    if (currentAddress && currentAddress !== address) {
      return fail('Unlink your current wallet before linking another', 409, 'WALLET_ALREADY_SET');
    }

    const owner = await this.findOwnerId(address);
    if (owner && owner !== userId) {
      await this.audit(userId, 'auth.wallet_link', address, false, 'WALLET_ALREADY_LINKED');
      return fail('This wallet is already linked to another account', 409, 'WALLET_ALREADY_LINKED');
    }

    const { error } = await supabase
      .from('users')
      .update({ stellar_address: address })
      .eq('id', userId);

    if (error) {
      // The unique index rejects a concurrent claim of the same address.
      await this.audit(userId, 'auth.wallet_link', address, false, 'WALLET_ALREADY_LINKED');
      return fail('This wallet is already linked to another account', 409, 'WALLET_ALREADY_LINKED');
    }

    await this.audit(userId, 'auth.wallet_link', address, true);
    return { success: true, data: { address, userId } };
  }

  /**
   * Unlink the wallet from the authenticated account. Refused when it would leave
   * the account without a recovery method: an address and a verified email.
   */
  private async unlinkWallet(userId: string, address: string): Promise<ServiceResponse<VerifyResponse>> {
    const { data: userRow } = await supabase
      .from('users')
      .select('id, email, email_verified, stellar_address')
      .eq('id', userId)
      .single();

    const user = userRow as {
      email: string | null;
      email_verified: boolean | null;
      stellar_address: string | null;
    } | null;

    if (!user || user.stellar_address !== address) {
      return fail('This wallet is not linked to your account', 409, 'WALLET_NOT_LINKED');
    }

    if (!user.email || !user.email_verified) {
      await this.audit(userId, 'auth.wallet_unlink', address, false, 'LAST_SIGN_IN_METHOD');
      return fail(
        'Verify an email address before unlinking your only wallet sign-in',
        409,
        'LAST_SIGN_IN_METHOD',
      );
    }

    const { error } = await supabase
      .from('users')
      .update({ stellar_address: null })
      .eq('id', userId)
      .eq('stellar_address', address);

    if (error) {
      return fail('Failed to unlink wallet', 500, 'UNLINK_FAILED');
    }

    await this.audit(userId, 'auth.wallet_unlink', address, true);
    return { success: true, data: { address, userId } };
  }

  /** Begin unlinking: issues a challenge for the wallet currently linked to the account. */
  async generateUnlinkChallenge(userId: string): Promise<ServiceResponse<ChallengeResponse & { address: string }>> {
    const { data } = await supabase
      .from('users')
      .select('stellar_address')
      .eq('id', userId)
      .single();

    const address = (data as { stellar_address: string | null } | null)?.stellar_address ?? null;
    if (!address) {
      return fail('No wallet is linked to your account', 409, 'WALLET_NOT_LINKED');
    }

    const result = await this.generateChallenge(address, { purpose: 'unlink', userId });
    if (!result.success) return result as ServiceResponse<ChallengeResponse & { address: string }>;
    return { success: true, data: { challenge: result.data!.challenge, address } };
  }

  private async audit(
    userId: string,
    action: AuditAction,
    address: string,
    success: boolean,
    reason?: string,
  ): Promise<void> {
    await auditLogger.log({
      actorId: userId,
      action,
      resourceType: 'auth',
      resourceId: userId,
      success,
      meta: { address, ...(reason ? { reason } : {}) },
    });
  }
}
