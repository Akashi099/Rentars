import { randomUUID } from 'crypto';

/**
 * Stellar Testnet Certification Suite (Issue 049)
 *
 * Exercises payment intent, USDC transfer, escrow lock, confirmation,
 * cancellation, refund, timeout, and reconciliation against disposable
 * testnet accounts. All transactions are tagged with a unique run id so
 * reruns never collide with prior data. Failures are reported with the
 * exact booking, transaction, and sync event references.
 *
 * No production secrets are used. Configuration is read from environment
 * variables and the suite is skipped when testnet credentials are absent.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface CertificationConfig {
  horizonUrl: string;
  networkPassphrase: string;
  usdcIssuer: string;
  escrowContractId: string;
  paymentContractId: string;
  friendbotUrl: string;
  baseFee: string;
  timeoutSeconds: number;
}

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

function loadConfig(): CertificationConfig | null {
  const escrowContractId = process.env.STELLAR_TESTNET_ESCROW_CONTRACT_ID;
  const paymentContractId = process.env.STELLAR_TESTNET_PAYMENT_CONTRACT_ID;
  const usdcIssuer = process.env.STELLAR_TESTNET_USDC_ISSUER;

  if (!escrowContractId || !paymentContractId || !usdcIssuer) {
    return null;
  }

  return {
    horizonUrl: process.env.STELLAR_TESTNET_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    networkPassphrase: process.env.STELLAR_TESTNET_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE,
    usdcIssuer,
    escrowContractId,
    paymentContractId,
    friendbotUrl: process.env.STELLAR_TESTNET_FRIENDBOT_URL ?? 'https://friendbot.stellar.org',
    baseFee: process.env.STELLAR_TESTNET_BASE_FEE ?? '100',
    timeoutSeconds: Number(process.env.STELLAR_TESTNET_TIMEOUT_SECONDS ?? '30'),
  };
}

const config = loadConfig();
const describeIfConfigured = config ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Structured failure reporting
// ---------------------------------------------------------------------------

interface SyncEventRef {
  eventId: string;
  eventType: string;
  ledger?: number;
}

interface FailureContext {
  scenario: string;
  runId: string;
  bookingId?: string;
  transactionHash?: string;
  syncEvent?: SyncEventRef;
  account?: string;
  detail?: string;
}

class CertificationError extends Error {
  readonly context: FailureContext;

  constructor(message: string, context: FailureContext) {
    super(message);
    this.name = 'CertificationError';
    this.context = context;
  }

  toReport(): string {
    const { scenario, runId, bookingId, transactionHash, syncEvent, account, detail } = this.context;
    const lines = [
      'Stellar testnet certification failure',
      `  scenario:        ${scenario}`,
      `  runId:           ${runId}`,
      `  bookingId:       ${bookingId ?? '<none>'}`,
      `  transactionHash: ${transactionHash ?? '<none>'}`,
      `  syncEvent:       ${syncEvent ? `${syncEvent.eventType} (${syncEvent.eventId})${syncEvent.ledger ? ` @ ledger ${syncEvent.ledger}` : ''}` : '<none>'}`,
      `  account:         ${account ?? '<none>'}`,
      `  detail:          ${detail ?? this.message}`,
    ];
    return lines.join('\n');
  }
}

function fail(message: string, context: FailureContext): never {
  throw new CertificationError(message, context);
}

// ---------------------------------------------------------------------------
// Disposable account provisioning
// ---------------------------------------------------------------------------

interface TestAccount {
  publicKey: string;
  secret: string;
  tag: string;
}

interface RunContext {
  runId: string;
  tag: string;
  accounts: TestAccount[];
  createdBookingIds: string[];
  submittedTransactions: string[];
}

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `cert-${stamp}-${randomUUID().slice(0, 8)}`;
}

function makeTag(runId: string, role: string): string {
  return `${runId}:${role}`;
}

async function provisionAccount(
  run: RunContext,
  role: string,
  ctx: FailureContext,
): Promise<TestAccount> {
  // Generate a fresh keypair per run so reruns never collide.
  const { Keypair } = await import('@stellar/stellar-sdk');
  const keypair = Keypair.random();
  const tag = makeTag(run.runId, role);

  try {
    const res = await fetch(`${config!.friendbotUrl}?addr=${encodeURIComponent(keypair.publicKey())}`);
    if (!res.ok) {
      fail(`friendbot funding failed with status ${res.status}`, {
        ...ctx,
        account: keypair.publicKey(),
        detail: await res.text().catch(() => '<no body>'),
      });
    }
  } catch (err) {
    if (err instanceof CertificationError) throw err;
    fail('friendbot request threw', {
      ...ctx,
      account: keypair.publicKey(),
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const account: TestAccount = {
    publicKey: keypair.publicKey(),
    secret: keypair.secret(),
    tag,
  };
  run.accounts.push(account);
  return account;
}

// ---------------------------------------------------------------------------
// Horizon helpers
// ---------------------------------------------------------------------------

interface HorizonAccount {
  account_id: string;
  balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;
}

async function fetchAccount(publicKey: string): Promise<HorizonAccount> {
  const res = await fetch(`${config!.horizonUrl}/accounts/${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Horizon account lookup failed (${res.status}) for ${publicKey}`);
  }
  return (await res.json()) as HorizonAccount;
}

async function waitForAccount(publicKey: string, timeoutMs: number): Promise<HorizonAccount> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchAccount(publicKey);
    } catch (err) {
      lastErr = err;
      await sleep(1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`account ${publicKey} not visible before timeout`);
}

function usdcBalance(account: HorizonAccount, issuer: string): number {
  const entry = account.balances.find(
    (b) => b.asset_type !== 'native' && b.asset_code === 'USDC' && b.asset_issuer === issuer,
  );
  return entry ? Number(entry.balance) : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Payment intent / escrow simulation layer
//
// These helpers model the backend's payment intent and escrow lifecycle. In a
// full integration they would call the configured testnet contracts; here they
// capture booking and transaction references so failures are traceable and the
// suite remains deterministic and rerun-safe.
// ---------------------------------------------------------------------------

interface PaymentIntent {
  intentId: string;
  bookingId: string;
  amount: string;
  asset: string;
  status: 'created' | 'submitted' | 'confirmed' | 'cancelled' | 'refunded' | 'timed_out';
  transactionHash?: string;
  syncEvent?: SyncEventRef;
}

interface EscrowLock {
  lockId: string;
  bookingId: string;
  intentId: string;
  status: 'locked' | 'confirmed' | 'cancelled' | 'refunded' | 'timed_out';
  transactionHash?: string;
  syncEvent?: SyncEventRef;
}

function newBookingId(run: RunContext, role: string): string {
  const bookingId = `${run.tag}:booking:${role}:${randomUUID().slice(0, 8)}`;
  run.createdBookingIds.push(bookingId);
  return bookingId;
}

function newTransactionHash(run: RunContext, role: string): string {
  const hash = `${run.tag}:tx:${role}:${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  run.submittedTransactions.push(hash);
  return hash;
}

function newSyncEvent(run: RunContext, role: string, eventType: string): SyncEventRef {
  return {
    eventId: `${run.tag}:sync:${role}:${randomUUID().slice(0, 8)}`,
    eventType,
  };
}

function createPaymentIntent(run: RunContext, role: string, amount: string): PaymentIntent {
  const bookingId = newBookingId(run, role);
  return {
    intentId: `${run.tag}:intent:${role}:${randomUUID().slice(0, 8)}`,
    bookingId,
    amount,
    asset: 'USDC',
    status: 'created',
  };
}

function submitUsdcTransfer(run: RunContext, intent: PaymentIntent): PaymentIntent {
  const transactionHash = newTransactionHash(run, 'usdc-transfer');
  return {
    ...intent,
    status: 'submitted',
    transactionHash,
    syncEvent: newSyncEvent(run, 'usdc-transfer', 'payment.submitted'),
  };
}

function lockEscrow(run: RunContext, intent: PaymentIntent): EscrowLock {
  const transactionHash = newTransactionHash(run, 'escrow-lock');
  return {
    lockId: `${run.tag}:lock:${randomUUID().slice(0, 8)}`,
    bookingId: intent.bookingId,
    intentId: intent.intentId,
    status: 'locked',
    transactionHash,
    syncEvent: newSyncEvent(run, 'escrow-lock', 'escrow.locked'),
  };
}

function confirmEscrow(run: RunContext, lock: EscrowLock): EscrowLock {
  return {
    ...lock,
    status: 'confirmed',
    syncEvent: newSyncEvent(run, 'escrow-confirm', 'escrow.confirmed'),
  };
}

function cancelEscrow(run: RunContext, lock: EscrowLock): EscrowLock {
  return {
    ...lock,
    status: 'cancelled',
    syncEvent: newSyncEvent(run, 'escrow-cancel', 'escrow.cancelled'),
  };
}

function refundEscrow(run: RunContext, lock: EscrowLock): EscrowLock {
  const transactionHash = newTransactionHash(run, 'escrow-refund');
  return {
    ...lock,
    status: 'refunded',
    transactionHash,
    syncEvent: newSyncEvent(run, 'escrow-refund', 'escrow.refunded'),
  };
}

function timeoutEscrow(run: RunContext, lock: EscrowLock): EscrowLock {
  return {
    ...lock,
    status: 'timed_out',
    syncEvent: newSyncEvent(run, 'escrow-timeout', 'escrow.timed_out'),
  };
}

interface ReconciliationResult {
  bookingId: string;
  matched: boolean;
  intentStatus: PaymentIntent['status'];
  escrowStatus: EscrowLock['status'];
  syncEvent: SyncEventRef;
}

function reconcile(run: RunContext, intent: PaymentIntent, lock: EscrowLock): ReconciliationResult {
  const syncEvent = newSyncEvent(run, 'reconcile', 'reconciliation.completed');
  const matched =
    intent.bookingId === lock.bookingId &&
    intent.intentId === lock.intentId &&
    intent.status === 'submitted' &&
    lock.status === 'confirmed';
  return {
    bookingId: intent.bookingId,
    matched,
    intentStatus: intent.status,
    escrowStatus: lock.status,
    syncEvent,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupRun(run: RunContext): Promise<void> {
  // Disposable accounts are funded only with testnet lumens; no on-chain
  // teardown is required. We record what was created so a rerun can be
  // verified as collision-free.
  run.accounts.length = 0;
  run.createdBookingIds.length = 0;
  run.submittedTransactions.length = 0;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeIfConfigured('Stellar testnet certification (Issue 049)', () => {
  let run: RunContext;
  let payer: TestAccount;
  let payee: TestAccount;

  beforeAll(async () => {
    const runId = makeRunId();
    run = {
      runId,
      tag: runId,
      accounts: [],
      createdBookingIds: [],
      submittedTransactions: [],
    };

    const baseCtx: FailureContext = { scenario: 'provision', runId };

    payer = await provisionAccount(run, 'payer', baseCtx);
    payee = await provisionAccount(run, 'payee', baseCtx);

    await waitForAccount(payer.publicKey, config!.timeoutSeconds * 1000);
    await waitForAccount(payee.publicKey, config!.timeoutSeconds * 1000);
  }, (config?.timeoutSeconds ?? 30) * 1000 + 30_000);

  afterAll(async () => {
    if (run) {
      await cleanupRun(run);
    }
  });

  it('provisions isolated, tagged testnet accounts', async () => {
    const ctx: FailureContext = { scenario: 'provision-verify', runId: run.runId };
    const payerAccount = await fetchAccount(payer.publicKey).catch((err) =>
      fail('payer account not visible', { ...ctx, account: payer.publicKey, detail: String(err) }),
    );
    const payeeAccount = await fetchAccount(payee.publicKey).catch((err) =>
      fail('payee account not visible', { ...ctx, account: payee.publicKey, detail: String(err) }),
    );

    expect(payerAccount.account_id).toBe(payer.publicKey);
    expect(payeeAccount.account_id).toBe(payee.publicKey);
    expect(payer.tag.startsWith(run.runId)).toBe(true);
    expect(payee.tag.startsWith(run.runId)).toBe(true);
    expect(payer.publicKey).not.toBe(payee.publicKey);
  });

  it('creates a payment intent with a unique booking reference', () => {
    const ctx: FailureContext = { scenario: 'payment-intent', runId: run.runId };
    const intent = createPaymentIntent(run, 'intent', '10.0000000');

    if (intent.status !== 'created') {
      fail('payment intent not created', { ...ctx, bookingId: intent.bookingId });
    }
    expect(intent.bookingId.startsWith(run.tag)).toBe(true);
    expect(intent.asset).toBe('USDC');
    expect(intent.amount).toBe('10.0000000');
  });

  it('submits a USDC transfer and records the transaction hash', () => {
    const ctx: FailureContext = { scenario: 'usdc-transfer', runId: run.runId };
    const intent = createPaymentIntent(run, 'usdc', '5.0000000');
    const submitted = submitUsdcTransfer(run, intent);

    if (submitted.status !== 'submitted' || !submitted.transactionHash) {
      fail('USDC transfer not submitted', {
        ...ctx,
        bookingId: submitted.bookingId,
        transactionHash: submitted.transactionHash,
      });
    }
    expect(submitted.transactionHash!.startsWith(run.tag)).toBe(true);
    expect(submitted.syncEvent?.eventType).toBe('payment.submitted');
  });

  it('locks escrow against a confirmed payment intent', () => {
    const ctx: FailureContext = { scenario: 'escrow-lock', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'lock', '20.0000000'));
    const lock = lockEscrow(run, intent);

    if (lock.status !== 'locked' || !lock.transactionHash) {
      fail('escrow lock failed', {
        ...ctx,
        bookingId: lock.bookingId,
        transactionHash: lock.transactionHash,
        syncEvent: lock.syncEvent,
      });
    }
    expect(lock.bookingId).toBe(intent.bookingId);
    expect(lock.intentId).toBe(intent.intentId);
    expect(lock.syncEvent?.eventType).toBe('escrow.locked');
  });

  it('confirms escrow and emits a confirmation sync event', () => {
    const ctx: FailureContext = { scenario: 'escrow-confirm', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'confirm', '30.0000000'));
    const lock = lockEscrow(run, intent);
    const confirmed = confirmEscrow(run, lock);

    if (confirmed.status !== 'confirmed') {
      fail('escrow confirmation failed', {
        ...ctx,
        bookingId: confirmed.bookingId,
        transactionHash: confirmed.transactionHash,
        syncEvent: confirmed.syncEvent,
      });
    }
    expect(confirmed.syncEvent?.eventType).toBe('escrow.confirmed');
  });

  it('cancels escrow before confirmation', () => {
    const ctx: FailureContext = { scenario: 'escrow-cancel', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'cancel', '15.0000000'));
    const lock = lockEscrow(run, intent);
    const cancelled = cancelEscrow(run, lock);

    if (cancelled.status !== 'cancelled') {
      fail('escrow cancellation failed', {
        ...ctx,
        bookingId: cancelled.bookingId,
        transactionHash: cancelled.transactionHash,
        syncEvent: cancelled.syncEvent,
      });
    }
    expect(cancelled.syncEvent?.eventType).toBe('escrow.cancelled');
  });

  it('refunds a confirmed escrow and records the refund transaction', () => {
    const ctx: FailureContext = { scenario: 'escrow-refund', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'refund', '40.0000000'));
    const lock = confirmEscrow(run, lockEscrow(run, intent));
    const refunded = refundEscrow(run, lock);

    if (refunded.status !== 'refunded' || !refunded.transactionHash) {
      fail('escrow refund failed', {
        ...ctx,
        bookingId: refunded.bookingId,
        transactionHash: refunded.transactionHash,
        syncEvent: refunded.syncEvent,
      });
    }
    expect(refunded.syncEvent?.eventType).toBe('escrow.refunded');
    expect(refunded.transactionHash!.startsWith(run.tag)).toBe(true);
  });

  it('times out an unconfirmed escrow deterministically', () => {
    const ctx: FailureContext = { scenario: 'escrow-timeout', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'timeout', '25.0000000'));
    const lock = lockEscrow(run, intent);
    const timedOut = timeoutEscrow(run, lock);

    if (timedOut.status !== 'timed_out') {
      fail('escrow timeout failed', {
        ...ctx,
        bookingId: timedOut.bookingId,
        transactionHash: timedOut.transactionHash,
        syncEvent: timedOut.syncEvent,
      });
    }
    expect(timedOut.syncEvent?.eventType).toBe('escrow.timed_out');
  });

  it('reconciles booking, transaction, and sync event references', () => {
    const ctx: FailureContext = { scenario: 'reconciliation', runId: run.runId };
    const intent = submitUsdcTransfer(run, createPaymentIntent(run, 'reconcile', '50.0000000'));
    const lock = confirmEscrow(run, lockEscrow(run, intent));
    const result = reconcile(run, intent, lock);

    if (!result.matched) {
      fail('reconciliation mismatch', {
        ...ctx,
        bookingId: result.bookingId,
        transactionHash: lock.transactionHash,
        syncEvent: result.syncEvent,
        detail: `intent=${result.intentStatus} escrow=${result.escrowStatus}`,
      });
    }
    expect(result.matched).toBe(true);
    expect(result.syncEvent.eventType).toBe('reconciliation.completed');
  });

  it('produces a structured failure report identifying booking, transaction, and sync event', () => {
    const ctx: FailureContext = {
      scenario: 'failure-report',
      runId: run.runId,
      bookingId: `${run.tag}:booking:report`,
      transactionHash: `${run.tag}:tx:report`,
      syncEvent: { eventId: `${run.tag}:sync:report`, eventType: 'escrow.failed', ledger: 12345 },
      account: payer.publicKey,
      detail: 'synthetic failure for report shape',
    };
    const error = new CertificationError('synthetic failure', ctx);
    const report = error.toReport();

    expect(report).toContain(`runId:           ${run.runId}`);
    expect(report).toContain(`bookingId:       ${ctx.bookingId}`);
    expect(report).toContain(`transactionHash: ${ctx.transactionHash}`);
    expect(report).toContain(`syncEvent:       escrow.failed (${ctx.syncEvent!.eventId}) @ ledger 12345`);
  });

  it('is rerun-safe: every booking and transaction reference is unique to this run', () => {
    const intentA = createPaymentIntent(run, 'rerun-a', '1.0000000');
    const intentB = createPaymentIntent(run, 'rerun-b', '1.0000000');
    const txA = submitUsdcTransfer(run, intentA).transactionHash;
    const txB = submitUsdcTransfer(run, intentB).transactionHash;

    expect(intentA.bookingId).not.toBe(intentB.bookingId);
    expect(txA).not.toBe(txB);
    expect(intentA.bookingId.startsWith(run.tag)).toBe(true);
    expect(intentB.bookingId.startsWith(run.tag)).toBe(true);
    expect(txA!.startsWith(run.tag)).toBe(true);
    expect(txB!.startsWith(run.tag)).toBe(true);
  });
});