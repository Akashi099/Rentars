/**
 * Unit tests for reviewSync.service — on-chain review reconciliation.
 *
 * Covers:
 *   - reconcileReview: matched / mismatched / missing / skip-when-no-on-chain-id
 *   - detectDuplicateOnChainIds: duplicate detection and repair queue
 *   - getReviewRepairQueue: listing open/in-progress tasks
 *   - resolveRepairTask: resolution clears reconciliation status
 *   - recordOnChainSubmission: stores immutable chain references
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─── Supabase mock ────────────────────────────────────────────────────────────

type ChainNode = Record<string, unknown>;

function chain(result: unknown): ChainNode {
  const node: ChainNode = {};
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'not',
    'in', 'lt', 'is', 'or', 'order', 'single'];
  for (const m of methods) {
    node[m] = mock(() => node);
  }
  node['maybeSingle'] = mock(async () => result);
  node['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

const mockFrom = mock((_: string) => chain({ data: null, error: null }));

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

// ─── Blockchain client mock ───────────────────────────────────────────────────

const mockGetReview = mock(async (_id: bigint) => ({
  id: 1n,
  reviewer: 'GABC',
  reviewee: 'GXYZ',
  rating: 4,
  comment: 'Great stay',
  timestamp: 1700000000n,
}));

const mockReviewCount = mock(async () => 0n);

mock.module('../../src/blockchain/reviewClient.js', () => ({
  ReviewClient: mock(function () {
    return { getReview: mockGetReview, reviewCount: mockReviewCount };
  }),
}));

mock.module('../../src/blockchain/config.js', () => ({
  REVIEW_CONTRACT_ID: 'CTEST123',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  STELLAR_RPC_URL: 'https://soroban-testnet.stellar.org',
}));

mock.module('../../src/services/auditLog.service.js', () => ({
  record: mock(async () => ({ success: true })),
}));

import {
  reconcileReview,
  detectDuplicateOnChainIds,
  getReviewRepairQueue,
  resolveRepairTask,
  recordOnChainSubmission,
} from '../../src/services/reviewSync.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('reconcileReview', () => {
  beforeEach(() => {
    mockFrom.mockClear();
    mockGetReview.mockClear();
  });

  it('returns status=none when review has no on_chain_id', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: { id: 'r1', on_chain_id: null, rating: 4, comment: 'ok',
          original_rating: 4, original_comment: 'ok', reviewer_id: 'u1',
          target_id: 'u2', reconciliation_status: 'none',
          on_chain_timestamp: null, on_chain_tx_hash: null, on_chain_ledger: null },
        error: null,
      }),
    );
    const result = await reconcileReview('r1');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('none');
    expect(mockGetReview).not.toHaveBeenCalled();
  });

  it('returns status=matched when on-chain data agrees with originals', async () => {
    // DB row with matching original data
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r2', on_chain_id: 1, rating: 4, comment: 'Great stay',
          original_rating: 4, original_comment: 'Great stay',
          reviewer_id: 'u1', target_id: 'u2', reconciliation_status: 'pending',
          on_chain_timestamp: null, on_chain_tx_hash: null, on_chain_ledger: null,
        },
        error: null,
      }),
    );

    // On-chain review matches
    mockGetReview.mockImplementation(async () => ({
      id: 1n, reviewer: 'GABC', reviewee: 'GXYZ',
      rating: 4, comment: 'Great stay', timestamp: 1700000000n,
    }));

    const result = await reconcileReview('r2');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('matched');
  });

  it('returns status=mismatched when on-chain rating diverges', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r3', on_chain_id: 2, rating: 5, comment: 'Great stay',
          original_rating: 5, original_comment: 'Great stay',
          reviewer_id: 'u1', target_id: 'u2', reconciliation_status: 'pending',
          on_chain_timestamp: null, on_chain_tx_hash: null, on_chain_ledger: null,
        },
        error: null,
      }),
    );

    // On-chain has different rating
    mockGetReview.mockImplementation(async () => ({
      id: 2n, reviewer: 'GABC', reviewee: 'GXYZ',
      rating: 3, comment: 'Great stay', timestamp: 1700000001n,
    }));

    const result = await reconcileReview('r3');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('mismatched');
  });

  it('returns status=missing when on-chain review not found', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r4', on_chain_id: 99, rating: 4, comment: 'ok',
          original_rating: 4, original_comment: 'ok',
          reviewer_id: 'u1', target_id: 'u2', reconciliation_status: 'pending',
          on_chain_timestamp: null, on_chain_tx_hash: null, on_chain_ledger: null,
        },
        error: null,
      }),
    );

    mockGetReview.mockImplementation(async () => {
      throw new Error('Review not found');
    });

    const result = await reconcileReview('r4');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('missing');
  });

  it('returns error when review not found in DB', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'not found' } }),
    );
    const result = await reconcileReview('missing-review');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Review not found');
  });

  it('uses original_rating/original_comment for comparison, not displayed values', async () => {
    // Displayed rating may differ from original (moderation hid/changed it)
    // but the chain comparison must use originals.
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r5', on_chain_id: 5,
          rating: 1,              // displayed (potentially edited by moderation)
          comment: '[removed]',   // displayed
          original_rating: 4,     // immutable original
          original_comment: 'Nice place',
          reviewer_id: 'u1', target_id: 'u2', reconciliation_status: 'pending',
          on_chain_timestamp: null, on_chain_tx_hash: null, on_chain_ledger: null,
        },
        error: null,
      }),
    );

    // On-chain matches the ORIGINALS (not the displayed values)
    mockGetReview.mockImplementation(async () => ({
      id: 5n, reviewer: 'GABC', reviewee: 'GXYZ',
      rating: 4, comment: 'Nice place', timestamp: 1700000002n,
    }));

    const result = await reconcileReview('r5');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('matched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('detectDuplicateOnChainIds', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns 0 duplicates when all on_chain_ids are unique', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: [{ on_chain_id: 1 }, { on_chain_id: 2 }, { on_chain_id: 3 }], error: null }),
    );
    const result = await detectDuplicateOnChainIds();
    expect(result.success).toBe(true);
    expect(result.data!.duplicates).toBe(0);
  });

  it('detects a duplicate on_chain_id and queues a repair task', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: [{ on_chain_id: 7 }, { on_chain_id: 7 }, { on_chain_id: 9 }], error: null }),
    );
    const result = await detectDuplicateOnChainIds();
    expect(result.success).toBe(true);
    expect(result.data!.duplicates).toBe(1);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'DB error' } }),
    );
    const result = await detectDuplicateOnChainIds();
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getReviewRepairQueue', () => {
  beforeEach(() => mockFrom.mockClear());

  it('returns open tasks by default', async () => {
    const tasks = [
      { id: 't1', issue_type: 'mismatched', status: 'open' },
      { id: 't2', issue_type: 'missing', status: 'in_progress' },
    ];
    mockFrom.mockImplementation(() => chain({ data: tasks, error: null }));

    const result = await getReviewRepairQueue();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('filters by status when provided', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: [{ id: 't3', status: 'resolved' }], error: null }),
    );
    const result = await getReviewRepairQueue('resolved');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  it('returns empty array when no tasks exist', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await getReviewRepairQueue();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveRepairTask', () => {
  beforeEach(() => mockFrom.mockClear());

  it('resolves a task and returns the updated record', async () => {
    const task = {
      id: 't1', review_id: 'r1', on_chain_id: 5,
      issue_type: 'mismatched', status: 'resolved',
      resolution_note: 'Verified on chain', resolved_by: 'mod1', resolved_at: new Date().toISOString(),
    };
    mockFrom.mockImplementation(() => chain({ data: task, error: null }));

    const result = await resolveRepairTask('t1', 'mod1', 'Verified on chain');
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('resolved');
  });

  it('marks as wont_fix when flag is set', async () => {
    const task = {
      id: 't2', review_id: null, on_chain_id: 9,
      issue_type: 'orphaned', status: 'wont_fix',
      resolution_note: 'Pre-migration record', resolved_by: 'mod1',
      resolved_at: new Date().toISOString(),
    };
    mockFrom.mockImplementation(() => chain({ data: task, error: null }));

    const result = await resolveRepairTask('t2', 'mod1', 'Pre-migration record', true);
    expect(result.success).toBe(true);
    expect(result.data!.status).toBe('wont_fix');
  });

  it('returns not found when no task matches', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await resolveRepairTask('missing', 'mod1', 'note');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Repair task not found');
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'update failed' } }),
    );
    const result = await resolveRepairTask('t1', 'mod1', 'note');
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('recordOnChainSubmission', () => {
  beforeEach(() => mockFrom.mockClear());

  it('records on-chain metadata successfully', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await recordOnChainSubmission('r1', 42, 'abc-tx-hash', 9000, 1700000000);
    expect(result.success).toBe(true);
  });

  it('works without optional fields', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await recordOnChainSubmission('r1', 42);
    expect(result.success).toBe(true);
  });

  it('returns error on DB failure', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: null, error: { message: 'update failed' } }),
    );
    const result = await recordOnChainSubmission('r1', 42);
    expect(result.success).toBe(false);
  });
});
