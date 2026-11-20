import type * as StellarSdk from '@stellar/stellar-sdk';
import { PasskeyUnsupportedError } from './status';

/**
 * Derive a Stellar keypair from a passkey credential.
 *
 * Not implemented: there is no supported derivation. Returning a random keypair
 * would create a signing identity no passkey controls, so this always rejects.
 */
export async function deriveKeyFromPasskey(_credentialId: string): Promise<StellarSdk.Keypair> {
  throw new PasskeyUnsupportedError('key derivation');
}

/**
 * Verify a passkey assertion against its credential.
 *
 * Not implemented. The previous placeholder returned true for any input, so this
 * now rejects rather than letting a signature be accepted without verification.
 */
export async function verifyPasskeySignature(
  _credentialId: string,
  _signature: string,
  _data: string,
): Promise<boolean> {
  throw new PasskeyUnsupportedError('signature verification');
}
