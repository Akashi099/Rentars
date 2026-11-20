# Passkey-to-Stellar wallets: current decision

Status: **not supported**. Tracked by issue #913.

## What was wrong

`apps/web/src/lib/passkey/` contained placeholder logic that could look like a working wallet:

- `deriveKeyFromPasskey` returned a random Stellar keypair, which no passkey controlled.
- `verifyPasskeySignature` returned `true` for any input.
- `deployStellarSmartWallet` submitted a memo-only transaction signed by that random keypair, so it could report a deployed wallet that does not exist.
- `useStellar().prepareSign` returned the literal string `placeholder_xdr`.

## What the code does now

Every passkey entry point fails closed with `PasskeyUnsupportedError` (`code: PASSKEY_UNSUPPORTED`). Nothing is generated, signed or submitted. `useStellar` exposes `passkeySupported: false` so UI can show an explicit fallback to email or a Freighter wallet.

Read-only account lookups (`getSmartWalletDetails`) are unchanged.

## Supported model (to be chosen)

Before passkey wallets can be enabled, a provider must be selected and documented, covering:

1. Platforms and browsers that support the flow.
2. How the Stellar key is derived or held: an audited smart-account / passkey-signer integration, not a locally derived key.
3. Account recovery when a passkey is lost.
4. Transaction-signing requirements, including network passphrase checks.

Once selected, flip `PASSKEY_WALLET_SUPPORTED` in `apps/web/src/lib/passkey/status.ts` only together with that integration and its tests.
