/**
 * Security regression suite (#746).
 *
 * Each test pins a control from docs/THREAT_MODEL.md so that removing it fails CI.
 * Coverage map (threat id → test):
 *   2.1 JWT forgery / default secret ........ "authenticate" and "admin gate" blocks
 *   3.1 Booking/wallet replay ............... "wallet challenge" block (replay, expiry)
 *   1.3 Property/image IDOR ................. "cross-tenant access" block
 *   1.2 Profile/privacy IDOR ................ "cross-tenant access" block
 *
 * Uses an in-memory table engine that honours eq/in/gt filters, so IDOR checks
 * exercise the real query scoping rather than a hand-written stub result.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import jwt from 'jsonwebtoken';
import { Keypair } from '@stellar/stellar-sdk';

// ── In-memory table engine ────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in' | 'gt' | 'lt'; column: string; value: unknown };

const db: Record<string, Row[]> = {};
let idCounter = 0;

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.column];
      switch (f.op) {
        case 'eq':
          return v === f.value;
        case 'in':
          return (f.value as unknown[]).includes(v);
        case 'gt':
          return String(v) > String(f.value);
        case 'lt':
          return String(v) < String(f.value);
      }
    })
  );
}

function engine(table: string) {
  const filters: Filter[] = [];
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row | undefined;

  const run = (): { data: Row[]; error: { message: string } | null } => {
    db[table] ??= [];
    if (mode === 'insert') {
      const row = { id: `row-${++idCounter}`, ...payload } as Row;
      db[table].push(row);
      return { data: [row], error: null };
    }
    const matched = applyFilters(db[table], filters);
    if (mode === 'update') {
      for (const row of matched) Object.assign(row, payload);
      return { data: matched, error: null };
    }
    if (mode === 'delete') {
      db[table] = db[table].filter((row) => !matched.includes(row));
      return { data: matched, error: null };
    }
    return { data: matched, error: null };
  };

  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (column: string, value: unknown) => (filters.push({ op: 'eq', column, value }), chain);
  chain.in = (column: string, value: unknown[]) => (
    filters.push({ op: 'in', column, value }), chain
  );
  chain.gt = (column: string, value: unknown) => (filters.push({ op: 'gt', column, value }), chain);
  chain.lt = (column: string, value: unknown) => (filters.push({ op: 'lt', column, value }), chain);
  chain.limit = () => chain;
  chain.order = () => chain;
  chain.insert = (row: Row) => ((mode = 'insert'), (payload = row), chain);
  chain.update = (row: Row) => ((mode = 'update'), (payload = row), chain);
  chain.upsert = (row: Row) => ((mode = 'insert'), (payload = row), chain);
  chain.delete = () => ((mode = 'delete'), chain);
  chain.single = () => {
    const { data } = run();
    return Promise.resolve(
      data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'no rows' } }
    );
  };
  chain.maybeSingle = chain.single;
  // biome-ignore lint/suspicious/noThenProperty: the builder is awaited like a Supabase query
  chain.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(run()).then(resolve, reject);
  return chain;
}

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: (table: string) => engine(table) },
}));

mock.module('../../src/config/env.js', () => ({
  env: { MAX_IMAGES_PER_PROPERTY: 10, MAX_IMAGE_SIZE_BYTES: 5242880 },
}));

mock.module('../../src/services/logging.service.js', () => ({
  setRequestContextUserId: () => undefined,
  loggingService: { log: () => undefined },
}));

mock.module('../../src/services/auditLogger.service.js', () => ({
  auditLogger: { log: async () => undefined },
}));

mock.module('../../src/services/cache.service.js', () => ({
  del: async () => true,
  get: async () => null,
  set: async () => true,
}));

const SECRET = 's'.repeat(48);
const ATTACKER_SECRET = 'a'.repeat(48);

const { authenticate } = await import('../../src/middleware/auth.middleware.js');
const { requireAdminRole } = await import('../../src/middleware/adminScope.middleware.js');
const { WalletAuthService } = await import('../../src/services/wallet.service.js');
const propertyImage = await import('../../src/services/propertyImage.service.js');
const privacy = await import('../../src/services/privacy.service.js');

type Captured = { status?: number; body?: unknown; nextCalled: boolean; userId?: string };

function runMiddleware(
  middleware: (req: any, res: any, next: () => void) => void,
  authHeader?: string
): Captured {
  const captured: Captured = { nextCalled: false };
  const req: any = { headers: authHeader ? { authorization: authHeader } : {} };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    send() {
      return res;
    },
  };
  middleware(req, res, () => {
    captured.nextCalled = true;
  });
  captured.userId = req.userId;
  return captured;
}

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  process.env.JWT_SECRET = SECRET;
  delete process.env.ADMIN_JWT_SECRET;
});

// ── Forgery: authentication must use the configured secret only ───────────────

describe('authenticate — token forgery (2.1)', () => {
  it('accepts a token signed with the configured JWT_SECRET (positive control)', () => {
    const token = jwt.sign({ userId: 'user-1' }, SECRET);

    const result = runMiddleware(authenticate as any, `Bearer ${token}`);

    expect(result.nextCalled).toBe(true);
    expect(result.userId).toBe('user-1');
  });

  it('rejects a token signed with the old hard-coded default "secret"', () => {
    const forged = jwt.sign({ userId: 'victim' }, 'secret');

    const result = runMiddleware(authenticate as any, `Bearer ${forged}`);

    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });

  it('fails closed when JWT_SECRET is unset, even for a token signed with "secret"', () => {
    delete process.env.JWT_SECRET;
    const forged = jwt.sign({ userId: 'victim' }, 'secret');

    const result = runMiddleware(authenticate as any, `Bearer ${forged}`);

    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });
});

describe('admin gate — privilege escalation (2.1, 2.3)', () => {
  it('rejects an admin-role token signed with the default "secret"', () => {
    const forged = jwt.sign({ userId: 'attacker', role: 'admin' }, 'secret');

    const result = runMiddleware(requireAdminRole as any, `Bearer ${forged}`);

    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });

  it('rejects an admin-role token signed with a different key', () => {
    const forged = jwt.sign({ userId: 'attacker', role: 'admin' }, ATTACKER_SECRET);

    const result = runMiddleware(requireAdminRole as any, `Bearer ${forged}`);

    expect(result.status).toBe(401);
  });

  it('rejects a valid non-admin token even when correctly signed', () => {
    const token = jwt.sign({ userId: 'user-1', role: 'tenant' }, SECRET);

    const result = runMiddleware(requireAdminRole as any, `Bearer ${token}`);

    expect(result.status).toBe(403);
    expect(result.nextCalled).toBe(false);
  });
});

// ── Replay and wallet proof of possession (3.1) ───────────────────────────────

describe('wallet challenge — replay and proof of possession (3.1)', () => {
  const keypair = Keypair.random();
  const address = keypair.publicKey();
  const service = new WalletAuthService();

  async function issueChallenge(): Promise<string> {
    const result = await service.generateChallenge(address);
    expect(result.success).toBe(true);
    return (result.data as { challenge: string }).challenge;
  }

  it('issues a 256-bit hex challenge', async () => {
    const challenge = await issueChallenge();
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a valid signature and returns a token signed with JWT_SECRET', async () => {
    const challenge = await issueChallenge();
    const signature = keypair.sign(Buffer.from(challenge)).toString('base64');

    const result = await service.verifySignature(address, challenge, signature);

    expect(result.success).toBe(true);
    const token = (result.data as { token: string }).token;
    expect(() => jwt.verify(token, SECRET)).not.toThrow();
    expect(() => jwt.verify(token, 'secret')).toThrow();
  });

  it('rejects replay of an already-used challenge', async () => {
    const challenge = await issueChallenge();
    const signature = keypair.sign(Buffer.from(challenge)).toString('base64');

    const first = await service.verifySignature(address, challenge, signature);
    const replay = await service.verifySignature(address, challenge, signature);

    expect(first.success).toBe(true);
    expect(replay.success).toBe(false);
  });

  it('does not let an attacker sign for a victim address', async () => {
    const challenge = await issueChallenge();
    const attacker = Keypair.random();
    const forged = attacker.sign(Buffer.from(challenge)).toString('base64');

    const result = await service.verifySignature(address, challenge, forged);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid signature');
  });

  it('consumes the challenge on a bad signature so it cannot be brute-forced', async () => {
    const challenge = await issueChallenge();
    const attacker = Keypair.random();
    await service.verifySignature(
      address,
      challenge,
      attacker.sign(Buffer.from(challenge)).toString('base64')
    );

    const legitimate = keypair.sign(Buffer.from(challenge)).toString('base64');
    const retry = await service.verifySignature(address, challenge, legitimate);

    expect(retry.success).toBe(false);
  });

  it('rejects an expired challenge', async () => {
    const challenge = await issueChallenge();
    for (const row of db.wallet_challenges) {
      row.expires_at = new Date(Date.now() - 1000).toISOString();
    }
    const signature = keypair.sign(Buffer.from(challenge)).toString('base64');

    const result = await service.verifySignature(address, challenge, signature);

    expect(result.success).toBe(false);
  });
});

// ── Cross-tenant access (1.2, 1.3) ────────────────────────────────────────────

describe('cross-tenant access — IDOR (1.2, 1.3)', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const OTHER_OWNER = '55555555-5555-4555-8555-555555555555';
  const PROPERTY = '33333333-3333-4333-8333-333333333333';
  const OTHER_PROPERTY = '44444444-4444-4444-8444-444444444444';

  beforeEach(() => {
    db.properties = [
      { id: PROPERTY, owner_id: OWNER },
      { id: OTHER_PROPERTY, owner_id: OTHER_OWNER },
    ];
    db.property_images = [
      {
        id: 'img-mine',
        property_id: PROPERTY,
        url: 'https://cdn/x/mine.webp',
        thumbnail_url: null,
        is_primary: true,
      },
      {
        id: 'img-theirs',
        property_id: OTHER_PROPERTY,
        url: 'https://cdn/x/theirs.webp',
        thumbnail_url: null,
        is_primary: true,
      },
    ];
  });

  it("owner cannot delete another property's image by swapping the image id", async () => {
    const result = await propertyImage.removePropertyImage(PROPERTY, 'img-theirs', OWNER);

    expect(result.success).toBe(false);
    expect(db.property_images.find((i) => i.id === 'img-theirs')).toBeDefined();
  });

  it("owner cannot promote another property's image to primary", async () => {
    const result = await propertyImage.setPrimaryImage(PROPERTY, 'img-theirs', OWNER);

    expect(result.success).toBe(false);
    expect(db.property_images.find((i) => i.id === 'img-mine')?.is_primary).toBe(true);
  });

  it('user cannot manage images on a property they do not own', async () => {
    const result = await propertyImage.removePropertyImage(OTHER_PROPERTY, 'img-theirs', OWNER);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Forbidden');
  });

  it("user cannot read another user's deletion request by id", async () => {
    db.account_deletions = [{ id: 'del-9', user_id: OTHER_OWNER, status: 'pending' }];

    const result = await privacy.getDeletionRequest(OWNER, 'del-9');

    expect(result).toBeNull();
  });

  it("user cannot read another user's data export by id", async () => {
    db.data_exports = [
      {
        id: 'exp-9',
        user_id: OTHER_OWNER,
        status: 'completed',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        export_payload: { secret: true },
      },
    ];

    const result = await privacy.getDataExportStatus(OWNER, 'exp-9');

    expect(result).toBeNull();
  });
});
