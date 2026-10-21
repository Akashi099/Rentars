import { signWithFreighter, getNetworkPassphrase, FreighterError } from '@/lib/freighter-utils';
import * as StellarSdk from '@stellar/stellar-sdk';
import { getHorizonServer } from '@/lib/stellar';

export interface TransactionSignRequest {
  xdr: string;
  network: 'testnet' | 'mainnet';
}

export interface TransactionSignResponse {
  signedXdr: string;
  transactionHash: string;
}

/**
 * Sign a payment transaction for USDC transfer
 */
export async function signUSDCPaymentTransaction(
  senderPublicKey: string,
  recipientPublicKey: string,
  amount: string,
  network: 'testnet' | 'mainnet' = 'testnet'
): Promise<TransactionSignResponse> {
  try {
    const server = getHorizonServer(network);
    const passphrase = getNetworkPassphrase(network);

    // Get the sender's account info
    const sourceAccount = await server.loadAccount(senderPublicKey);

    const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
    if (!usdcIssuer) {
      throw new Error('NEXT_PUBLIC_USDC_ISSUER is not configured');
    }
    const usdcAsset = new StellarSdk.Asset('USDC', usdcIssuer);

    // Build transaction
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: recipientPublicKey,
          asset: usdcAsset,
          amount,
        })
      )
      .setTimeout(30)
      .build();

    // Sign with Freighter
    const signedXdr = await signWithFreighter(tx.toXDR(), network);

    // Get transaction hash
    const txHash = StellarSdk.hash(Buffer.from(signedXdr, 'base64')).toString('hex');

    return {
      signedXdr,
      transactionHash: txHash,
    };
  } catch (error) {
    throw new Error(
      `Failed to sign USDC payment: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Sign a transaction for escrow funding
 */
export async function signEscrowFundingTransaction(
  senderPublicKey: string,
  escrowId: string,
  amount: string,
  network: 'testnet' | 'mainnet' = 'testnet'
): Promise<TransactionSignResponse> {
  try {
    const server = getHorizonServer(network);
    const passphrase = getNetworkPassphrase(network);

    const sourceAccount = await server.loadAccount(senderPublicKey);

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addMemo(StellarSdk.Memo.text(`escrow:${escrowId}`))
      .setTimeout(30)
      .build();

    const signedXdr = await signWithFreighter(tx.toXDR(), network);
    const txHash = StellarSdk.hash(Buffer.from(signedXdr, 'base64')).toString('hex');

    return {
      signedXdr,
      transactionHash: txHash,
    };
  } catch (error) {
    if (error instanceof FreighterError && error.code === 'USER_REJECTED') {
      throw new Error('Transaction signing rejected by user');
    }
    throw new Error(
      `Failed to sign escrow funding transaction: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
}

/**
 * Sign a transaction for escrow release
 */
export async function signEscrowReleaseTransaction(
  ownerPublicKey: string,
  escrowId: string,
  network: 'testnet' | 'mainnet' = 'testnet'
): Promise<TransactionSignResponse> {
  try {
    const server = getHorizonServer(network);
    const passphrase = getNetworkPassphrase(network);

    const sourceAccount = await server.loadAccount(ownerPublicKey);

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: passphrase,
    })
      .addMemo(StellarSdk.Memo.text(`escrow-release:${escrowId}`))
      .setTimeout(30)
      .build();

    const signedXdr = await signWithFreighter(tx.toXDR(), network);
    const txHash = StellarSdk.hash(Buffer.from(signedXdr, 'base64')).toString('hex');

    return {
      signedXdr,
      transactionHash: txHash,
    };
  } catch (error) {
    if (error instanceof FreighterError && error.code === 'USER_REJECTED') {
      throw new Error('Transaction signing rejected by user');
    }
    throw new Error(
      `Failed to sign escrow release transaction: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
}

/**
 * Verify a signed transaction
 */
export async function verifySignedTransaction(
  signedXdr: string,
  network: 'testnet' | 'mainnet' = 'testnet'
): Promise<boolean> {
  try {
    const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase(network));
    return !!tx;
  } catch (error) {
    console.error('Failed to verify transaction:', error);
    return false;
  }
}

/**
 * Get wallet account balance for USDC
 */
export async function getUSDCBalance(
  walletAddress: string,
  network: 'testnet' | 'mainnet' = 'testnet'
): Promise<string> {
  try {
    const server = getHorizonServer(network);
    const account = await server.loadAccount(walletAddress);

    // Find USDC balance
    const usdcBalance = account.balances.find((balance) => balance.asset_code === 'USDC');

    return usdcBalance ? usdcBalance.balance : '0';
  } catch (error) {
    console.error('Failed to get USDC balance:', error);
    return '0';
  }
}
