import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';

// ── In-memory tables with the constraints that matter here ───────────────────
// Supports the query-builder operations WalletAuthService uses. Enforces the
// partial unique index on users.stellar_address so races are covered too.

type Row = Record<string, any>;
const db: Record<string, Row[]> = { users: [], wallet_challenges: [], profiles: [] };
let idSeq = 0;

type Filter = { column: string; value: unknown; op: 'eq' | 'gt' };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) =>
    f.op === 'eq' ? row[f.column] === f.value : String(row[f.column]) > String(f.value),
  );
}

function builder(table: string) {
  const filters: Filter[] = [];
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row = {};

  const run = (): { data: any; error: any } => {
    const rows = db[table];
    if (mode === 'insert') {
      const row: Row = { id: `${table}-${++idSeq}`, ...payload };
      if (table === 'users' && row.stellar_address) {
        const taken = rows.some((r) => r.stellar_address === row.stellar_address);
        if (taken) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      rows.push(row);
      return { data: [row], error: null };
    }
    const matched = rows.filter((r) => matches(r, filters));
    if (mode === 'update') {
      if (table === 'users' && payload.stellar_address) {
        const clash = rows.some(
          (r) => r.stellar_address === payload.stellar_address && !matched.includes(r),
        );
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      for (const r of matched) Object.assign(r, payload);
      return { data: matched, error: null };
    }
    if (mode === 'delete') {
      db[table] = rows.filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    }
    return { data: matched, error: null };
  };

  const chain: any = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => (filters.push({ column, value, op: 'eq' }), chain);
  chain.gt = (column: string, value: unknown) => (filters.push({ column, value, op: 'gt' }), chain);
  chain.insert = (row: Row) => ((mode = 'insert'), (payload = row), chain);
  chain.update = (row: Row) => ((mode = 'update'), (payload = row), chain);
  chain.upsert = (row: Row) => ((mode = 'insert'), (payload = row), chain);
  chain.delete = () => ((mode = 'delete'), chain);
  chain.single = () => {
    const { data, error } = run();
    if (error) return Promise.resolve({ data: null, error });
    const first = Array.isArray(data) ? data[0] : data;
    return Promise.resolve(first ? { data: first, error: null } : { data: null, error: { message: 'no rows' } });
  };
  chain.maybeSingle = () => {
    const { data, error } = run();
    if (error) return Promise.resolve({ data: null, error });
    return Promise.resolve({ data: data?.[0] ?? null, error: null });
  };
  // biome-ignore lint/suspicious/noThenProperty: the fake is awaited like a Supabase builder
  chain.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(resolve, reject);
  return chain;
}

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: (table: string) => builder(table) },
}));

const auditCalls: Array<Record<string, unknown>> = [];
mock.module('../../src/services/auditLogger.service.js', () => ({
  auditLogger: {
    log: async (entry: Record<string, unknown>) => {
      auditCalls.push(entry);
    },
  },
}));

const { WalletAuthService } = await import('../../src/services/wallet.service.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const service = new WalletAuthService();
const OWNER = 'user-owner';
const OTHER = 'user-other';

function seedUser(id: string, fields: Row = {}) {
  db.users.push({ id, role: 'tenant', email: null, email_verified: false, stellar_address: null, ...fields });
}

function sign(kp: Keypair, challenge: string) {
  return kp.sign(Buffer.from(challenge)).toString('base64');
}

async function issue(address: string, options: { purpose?: 'login' | 'link' | 'unlink'; userId?: string }) {
  const res = await service.generateChallenge(address, options);
  expect(res.success).toBe(true);
  return (res.data as { challenge: string }).challenge;
}

beforeEach(() => {
  db.users = [];
  db.wallet_challenges = [];
  db.profiles = [];
  auditCalls.length = 0;
  process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('wallet challenge binding', () => {
  it('rejects a login proof presented as a link proof', async () => {
    seedUser(OWNER, { email: 'o@example.com', email_verified: true });
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'login' });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('CHALLENGE_INVALID');
  });

  it('rejects a link challenge used by a different account (account switching)', async () => {
    seedUser(OWNER);
    seedUser(OTHER);
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OTHER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('CHALLENGE_INVALID');
  });

  it('rejects a challenge issued for a different network', async () => {
    seedUser(OWNER);
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('NETWORK_MISMATCH');
  });

  it('rejects an expired challenge', async () => {
    seedUser(OWNER);
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });
    for (const row of db.wallet_challenges) row.expires_at = new Date(Date.now() - 1000).toISOString();

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('CHALLENGE_INVALID');
  });

  it('does not let a link challenge be replayed', async () => {
    seedUser(OWNER);
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });
    const signature = sign(kp, challenge);

    const first = await service.verifySignature(kp.publicKey(), challenge, signature, { purpose: 'link', userId: OWNER });
    const replay = await service.verifySignature(kp.publicKey(), challenge, signature, { purpose: 'link', userId: OWNER });

    expect(first.success).toBe(true);
    expect(replay.success).toBe(false);
  });

  it('rejects a signature from a key other than the wallet', async () => {
    seedUser(OWNER);
    const kp = Keypair.random();
    const attacker = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(attacker, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('INVALID_SIGNATURE');
  });
});

describe('linking', () => {
  it('links a wallet the account proves it controls and writes an audit entry', async () => {
    seedUser(OWNER, { email: 'o@example.com', email_verified: true });
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(true);
    expect(db.users.find((u) => u.id === OWNER)?.stellar_address).toBe(kp.publicKey());
    expect(auditCalls.some((c) => c.action === 'auth.wallet_link' && c.success === true)).toBe(true);
  });

  it('refuses a challenge for an address already linked to another account', async () => {
    seedUser(OTHER, { stellar_address: null });
    const kp = Keypair.random();
    db.users.push({ id: OWNER, role: 'tenant', stellar_address: kp.publicKey() });

    const res = await service.generateChallenge(kp.publicKey(), { purpose: 'link', userId: OTHER });

    expect(res.success).toBe(false);
    expect(res.code).toBe('WALLET_ALREADY_LINKED');
    expect(res.statusCode).toBe(409);
  });

  it('refuses to link a second wallet while one is already set', async () => {
    const first = Keypair.random();
    const second = Keypair.random();
    seedUser(OWNER, { stellar_address: first.publicKey() });
    const challenge = await issue(second.publicKey(), { purpose: 'link', userId: OWNER });

    const res = await service.verifySignature(second.publicKey(), challenge, sign(second, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('WALLET_ALREADY_SET');
  });

  it('fails cleanly when a concurrent claim wins the unique index', async () => {
    seedUser(OWNER);
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'link', userId: OWNER });
    // Another account claims the address between challenge issue and verification.
    db.users.push({ id: OTHER, role: 'tenant', stellar_address: kp.publicKey() });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge), {
      purpose: 'link',
      userId: OWNER,
    });

    expect(res.success).toBe(false);
    expect(res.code).toBe('WALLET_ALREADY_LINKED');
    expect(db.users.find((u) => u.id === OWNER)?.stellar_address).toBeNull();
  });
});

describe('unlinking', () => {
  it('refuses to unlink the only sign-in method of a wallet-only account', async () => {
    const kp = Keypair.random();
    seedUser(OWNER, { stellar_address: kp.publicKey(), email: null });
    const challenge = await service.generateUnlinkChallenge(OWNER);
    const ch = (challenge.data as { challenge: string }).challenge;

    const res = await service.verifySignature(kp.publicKey(), ch, sign(kp, ch), { purpose: 'unlink', userId: OWNER });

    expect(res.success).toBe(false);
    expect(res.code).toBe('LAST_SIGN_IN_METHOD');
    expect(db.users.find((u) => u.id === OWNER)?.stellar_address).toBe(kp.publicKey());
  });

  it('unlinks when the account has a verified email', async () => {
    const kp = Keypair.random();
    seedUser(OWNER, { stellar_address: kp.publicKey(), email: 'o@example.com', email_verified: true });
    const issued = await service.generateUnlinkChallenge(OWNER);
    const ch = (issued.data as { challenge: string }).challenge;

    const res = await service.verifySignature(kp.publicKey(), ch, sign(kp, ch), { purpose: 'unlink', userId: OWNER });

    expect(res.success).toBe(true);
    expect(db.users.find((u) => u.id === OWNER)?.stellar_address).toBeNull();
    expect(auditCalls.some((c) => c.action === 'auth.wallet_unlink' && c.success === true)).toBe(true);
  });

  it('does not issue an unlink challenge when no wallet is linked', async () => {
    seedUser(OWNER, { stellar_address: null });
    const res = await service.generateUnlinkChallenge(OWNER);
    expect(res.success).toBe(false);
    expect(res.code).toBe('WALLET_NOT_LINKED');
  });

  it('does not unlink a wallet the account does not own', async () => {
    const owned = Keypair.random();
    const other = Keypair.random();
    seedUser(OWNER, { stellar_address: owned.publicKey(), email: 'o@example.com', email_verified: true });

    // No unlink challenge is issued for a wallet this account does not hold.
    const refused = await service.generateChallenge(other.publicKey(), { purpose: 'unlink', userId: OWNER });
    expect(refused.success).toBe(false);
    expect(refused.code).toBe('WALLET_NOT_LINKED');

    // A genuine challenge for the linked wallet cannot be signed with another key.
    const issued = await service.generateUnlinkChallenge(OWNER);
    const ch = (issued.data as { challenge: string }).challenge;
    const forged = await service.verifySignature(owned.publicKey(), ch, sign(other, ch), {
      purpose: 'unlink',
      userId: OWNER,
    });

    expect(forged.success).toBe(false);
    expect(forged.code).toBe('INVALID_SIGNATURE');
    expect(db.users.find((u) => u.id === OWNER)?.stellar_address).toBe(owned.publicKey());
  });
});

describe('wallet sign-in', () => {
  it('signs in to the account that already holds the linked wallet', async () => {
    const kp = Keypair.random();
    seedUser(OWNER, { stellar_address: kp.publicKey(), email: 'o@example.com', email_verified: true });
    const challenge = await issue(kp.publicKey(), { purpose: 'login' });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge));

    expect(res.success).toBe(true);
    expect(res.data?.userId).toBe(OWNER);
    expect(res.data?.token).toBeString();
    expect(db.users.filter((u) => u.stellar_address === kp.publicKey())).toHaveLength(1);
  });

  it('creates exactly one account for a new wallet', async () => {
    const kp = Keypair.random();
    const challenge = await issue(kp.publicKey(), { purpose: 'login' });

    const res = await service.verifySignature(kp.publicKey(), challenge, sign(kp, challenge));

    expect(res.success).toBe(true);
    expect(db.users.filter((u) => u.stellar_address === kp.publicKey())).toHaveLength(1);
  });
});
