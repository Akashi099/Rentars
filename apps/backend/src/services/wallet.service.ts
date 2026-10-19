import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { supabase } from '@/config/supabase.js';
import { getJwtSecret } from '@/config/jwtSecret.js';
import type { ServiceResponse } from './index.js';

export interface ChallengeResponse {
  challenge: string;
}

export interface VerifyResponse {
  token: string;
  address: string;
}

const CHALLENGE_EXPIRY = 5 * 60 * 1000; // 5 minutes

export class WalletAuthService {
  async generateChallenge(address: string): Promise<ServiceResponse<ChallengeResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { success: false, error: 'Invalid Stellar address' };
    }

    try {
      // 256 bits of randomness, single use (consumed in verifySignature).
      const challenge = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY);

      // Store challenge in database
      const { error } = await supabase.from('wallet_challenges').insert({
        address,
        challenge,
        expires_at: expiresAt.toISOString(),
      });

      if (error) {
        return { success: false, error: 'Failed to generate challenge' };
      }

      return { success: true, data: { challenge } };
    } catch (err) {
      return { success: false, error: 'Challenge generation failed' };
    }
  }

  async verifySignature(
    address: string,
    challenge: string,
    signature: string,
  ): Promise<ServiceResponse<VerifyResponse>> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      return { success: false, error: 'Invalid Stellar address' };
    }

    try {
      // Consume the challenge atomically before checking the signature. A
      // delete that returns no row means another request already used it, so
      // concurrent replays cannot both succeed.
      const { data: consumed, error: consumeError } = await supabase
        .from('wallet_challenges')
        .delete()
        .eq('address', address)
        .eq('challenge', challenge)
        .gt('expires_at', new Date().toISOString())
        .select('id');

      if (consumeError || !consumed || consumed.length === 0) {
        return { success: false, error: 'Challenge not found or expired' };
      }

      // Verify signature over the challenge bytes
      try {
        const keypair = Keypair.fromPublicKey(address);
        const signatureBuffer = Buffer.from(signature, 'base64');
        const challengeBuffer = Buffer.from(challenge);

        if (!keypair.verify(challengeBuffer, signatureBuffer)) {
          return { success: false, error: 'Invalid signature' };
        }
      } catch (err) {
        return { success: false, error: 'Invalid signature' };
      }

      const token = jwt.sign({ address, type: 'wallet' }, getJwtSecret(), { expiresIn: '24h' });

      // Create or update user profile
      const { error: upsertError } = await supabase.from('profiles').upsert({
        stellar_address: address,
        updated_at: new Date().toISOString(),
      });

      if (upsertError) {
        return { success: false, error: 'Failed to create user profile' };
      }

      return { success: true, data: { token, address } };
    } catch (err) {
      return { success: false, error: 'Verification failed' };
    }
  }
}
