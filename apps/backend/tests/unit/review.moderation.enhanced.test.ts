/**
 * Unit tests for enhanced review moderation workflow (review.service.ts).
 *
 * Covers:
 *   - reportReview: state transition, removed-review guard, admin notification
 *   - startModeration: state transition, invalid-state guard
 *   - takeModerationAction: hide/remove/keep, appeal deadline, aggregate cache invalidation
 *   - submitAppeal: deadline check, author guard, duplicate guard
 *   - resolveAppeal: approve restores visibility, deny keeps current visibility
 *   - getModerationQueue / getPendingAppeals
 *   - Aggregate recalculation: visibility filter applied to getAverageRating
 *   - Original content preservation in submitReview
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// ─── Supabase mock ────────────────────────────────────────────────────────────

function chain(result: unknown) {
  const node: Record<string, unknown> = {};
  const methods = ['select', 'insert', 'update', 'delete', 'eq', 'neq',
    'not', 'in', 'is', 'or', 'order', 'single'];
  for (const m of methods) node[m] = mock(() => node);
  node['then'] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

const mockFrom = mock((_: string) => chain({ data: null, error: null }));

mock.module('../../src/config/supabase.js', () => ({
  supabase: { from: mockFrom },
}));

mock.module('../../src/services/notification.service.js', () => ({
  createNotification: mock(async () => ({ success: true })),
  shouldSendInApp: mock(async () => true),
}));

mock.module('../../src/services/cache.service.js', () => ({
  del: mock(async () => {}),
  get: mock(async () => null),
  set: mock(async () => {}),
  invalidatePattern: mock(async () => {}),
}));

mock.module('../../src/utils/sanitize.js', () => ({
  sanitizeLongText: mock((s: string) => s.trim()),
  sanitizeResponse: mock((s: string) => s.trim()),
}));

mock.module('../../src/services/auditLog.service.js', () => ({
  record: mock(async () => ({ success: true })),
}));

import {
  reportReview,
  startModeration,
  takeModerationAction,
  submitAppeal,
  resolveAppeal,
  getModerationQueue,
  getPendingAppeals,
  getAverageRating,
  submitReview,
} from '../../src/services/review.service.js';

// ─────────────────────────────────────────────────────────────────────────────

describe('reportReview', () => {
  beforeEach(() => mockFrom.mockClear());

  it('reports a visible review and sets moderation_state to reported', async () => {
    const reviewRow = {
      id: 'r1', reviewer_id: 'u1', target_id: 'u2',
      property_id: 'p1', moderation_state: 'none', visibility: 'visible',
    };
    const updated = { ...reviewRow, is_flagged: true, moderation_state: 'reported' };

    mockFrom
      .mockImplementationOnce(() => chain({ data: reviewRow, error: null }))  // fetch
      .mockImplementationOnce(() => chain({ data: updated, error: null }))    // update
      .mockImplementation(() => chain({ data: [], error: null }));             // admin notification

    const result = await reportReview('r1', 'u1', 'harassment', 'ongoing threats');
    expect(result.success).toBe(true);
    expect(result.data!.moderation_state).toBe('reported');
  });

  it('rejects reporting a removed review', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r1', reviewer_id: 'u1', target_id: 'u2',
          property_id: null, moderation_state: 'resolved', visibility: 'removed',
        },
        error: null,
      }),
    );
    const result = await reportReview('r1', 'u1', 'spam');
    expect(result.success).toBe(false);
    expect(result.error).toContain('removed');
  });

  it('returns error when review not found', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: { message: 'not found' } }));
    const result = await reportReview('missing', 'u1', 'fraud');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Review not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('startModeration', () => {
  beforeEach(() => mockFrom.mockClear());

  it('transitions a reported review to under_review', async () => {
    mockFrom
      .mockImplementationOnce(() => chain({ data: { moderation_state: 'reported' }, error: null }))
      .mockImplementation(() => chain({ data: { id: 'r1', moderation_state: 'under_review' }, error: null }));

    const result = await startModeration('r1', 'mod1');
    expect(result.success).toBe(true);
    expect(result.data!.moderation_state).toBe('under_review');
  });

  it('rejects starting moderation on an already-appealed review', async () => {
    mockFrom.mockImplementation(() =>
      chain({ data: { moderation_state: 'appealed' }, error: null }),
    );
    const result = await startModeration('r1', 'mod1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('appealed');
  });

  it('returns error when review not found', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await startModeration('missing', 'mod1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Review not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('takeModerationAction', () => {
  beforeEach(() => mockFrom.mockClear());

  const base = {
    id: 'r1', reviewer_id: 'u1', target_id: 'u2',
    property_id: 'p1', moderation_state: 'under_review', visibility: 'visible',
  };

  it('hide action sets visibility to hidden', async () => {
    const updated = { ...base, visibility: 'hidden', moderation_state: 'action_taken' };
    mockFrom.mockImplementation(() => chain({ data: updated, error: null }));

    const result = await takeModerationAction('r1', 'mod1', 'hide', '2026-10-16.1', 'harassment', 'Harassment detected.');
    expect(result.success).toBe(true);
    expect(result.data!.visibility).toBe('hidden');
  });

  it('remove action sets visibility to removed', async () => {
    const updated = { ...base, visibility: 'removed', moderation_state: 'action_taken' };
    mockFrom.mockImplementation(() => chain({ data: updated, error: null }));

    const result = await takeModerationAction('r1', 'mod1', 'remove', '2026-10-16.1', 'fraud');
    expect(result.success).toBe(true);
    expect(result.data!.visibility).toBe('removed');
  });

  it('keep action sets visibility to visible and resolves state', async () => {
    const updated = { ...base, visibility: 'visible', moderation_state: 'resolved', is_approved: true };
    mockFrom.mockImplementation(() => chain({ data: updated, error: null }));

    const result = await takeModerationAction('r1', 'mod1', 'keep', '2026-10-16.1', 'spam');
    expect(result.success).toBe(true);
    expect(result.data!.visibility).toBe('visible');
    expect(result.data!.moderation_state).toBe('resolved');
  });

  it('returns error when review not found after update', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await takeModerationAction('r1', 'mod1', 'hide', '2026-10-16.1', 'spam');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Review not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('submitAppeal', () => {
  beforeEach(() => mockFrom.mockClear());

  it('rejects an empty appeal reason', async () => {
    const result = await submitAppeal('r1', 'u1', '  ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('rejects appeal by a non-reviewer', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r1', reviewer_id: 'u1', target_id: 'u2',
          moderation_state: 'action_taken', appeal_status: 'none',
          appeal_deadline: new Date(Date.now() + 86400000).toISOString(),
        },
        error: null,
      }),
    );
    const result = await submitAppeal('r1', 'other-user', 'I disagree');
    expect(result.success).toBe(false);
    expect(result.error).toContain('author');
  });

  it('rejects appeal when deadline has passed', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r1', reviewer_id: 'u1', target_id: 'u2',
          moderation_state: 'action_taken', appeal_status: 'none',
          // deadline in the past
          appeal_deadline: new Date(Date.now() - 86400000).toISOString(),
        },
        error: null,
      }),
    );
    const result = await submitAppeal('r1', 'u1', 'I disagree');
    expect(result.success).toBe(false);
    expect(result.error).toContain('deadline');
  });

  it('rejects duplicate appeal when already pending', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r1', reviewer_id: 'u1', target_id: 'u2',
          moderation_state: 'appealed', appeal_status: 'pending',
          appeal_deadline: new Date(Date.now() + 86400000).toISOString(),
        },
        error: null,
      }),
    );
    const result = await submitAppeal('r1', 'u1', 'I disagree');
    expect(result.success).toBe(false);
    expect(result.error).toContain('already pending');
  });

  it('succeeds for a valid appeal by the review author within deadline', async () => {
    const deadline = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    mockFrom
      .mockImplementationOnce(() =>
        chain({
          data: {
            id: 'r1', reviewer_id: 'u1', target_id: 'u2',
            moderation_state: 'action_taken', appeal_status: 'none',
            appeal_deadline: deadline,
          },
          error: null,
        }),
      )
      .mockImplementationOnce(() =>
        chain({
          data: {
            id: 'r1', moderation_state: 'appealed', appeal_status: 'pending',
            appeal_reason: 'I disagree with the decision',
          },
          error: null,
        }),
      )
      .mockImplementation(() => chain({ data: [], error: null })); // admin notification

    const result = await submitAppeal('r1', 'u1', 'I disagree with the decision');
    expect(result.success).toBe(true);
    expect(result.data!.appeal_status).toBe('pending');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAppeal', () => {
  beforeEach(() => mockFrom.mockClear());

  it('approved appeal restores visibility to visible', async () => {
    mockFrom
      .mockImplementationOnce(() =>
        chain({
          data: {
            id: 'r1', reviewer_id: 'u1', target_id: 'u2',
            appeal_status: 'pending', visibility: 'hidden',
          },
          error: null,
        }),
      )
      .mockImplementation(() =>
        chain({
          data: {
            id: 'r1', reviewer_id: 'u1', target_id: 'u2',
            visibility: 'visible', moderation_state: 'resolved', appeal_status: 'approved',
          },
          error: null,
        }),
      );

    const result = await resolveAppeal('r1', 'mod1', true);
    expect(result.success).toBe(true);
    expect(result.data!.visibility).toBe('visible');
    expect(result.data!.appeal_status).toBe('approved');
  });

  it('denied appeal keeps current visibility', async () => {
    mockFrom
      .mockImplementationOnce(() =>
        chain({
          data: {
            id: 'r1', reviewer_id: 'u1', target_id: 'u2',
            appeal_status: 'pending', visibility: 'removed',
          },
          error: null,
        }),
      )
      .mockImplementation(() =>
        chain({
          data: {
            id: 'r1', reviewer_id: 'u1', target_id: 'u2',
            visibility: 'removed', moderation_state: 'resolved', appeal_status: 'denied',
          },
          error: null,
        }),
      );

    const result = await resolveAppeal('r1', 'mod1', false);
    expect(result.success).toBe(true);
    expect(result.data!.visibility).toBe('removed');
    expect(result.data!.appeal_status).toBe('denied');
  });

  it('returns error when no pending appeal exists', async () => {
    mockFrom.mockImplementation(() =>
      chain({
        data: {
          id: 'r1', reviewer_id: 'u1', target_id: 'u2',
          appeal_status: 'none', visibility: 'visible',
        },
        error: null,
      }),
    );
    const result = await resolveAppeal('r1', 'mod1', true);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No pending appeal');
  });

  it('returns error when review not found', async () => {
    mockFrom.mockImplementation(() => chain({ data: null, error: null }));
    const result = await resolveAppeal('missing', 'mod1', true);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Review not found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getModerationQueue / getPendingAppeals', () => {
  beforeEach(() => mockFrom.mockClear());

  it('getModerationQueue returns reviews in active moderation states', async () => {
    const queue = [
      { id: 'r1', moderation_state: 'reported' },
      { id: 'r2', moderation_state: 'under_review' },
    ];
    mockFrom.mockImplementation(() => chain({ data: queue, error: null }));
    const result = await getModerationQueue();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('getPendingAppeals returns only pending appeals', async () => {
    const appeals = [{ id: 'r3', appeal_status: 'pending' }];
    mockFrom.mockImplementation(() => chain({ data: appeals, error: null }));
    const result = await getPendingAppeals();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('getAverageRating — only visible reviews counted', () => {
  beforeEach(() => mockFrom.mockClear());

  it('excludes hidden/removed reviews from the average', async () => {
    // Only visible + is_approved rows are returned (filter is in the query).
    mockFrom.mockImplementation(() =>
      chain({ data: [{ rating: 4 }, { rating: 5 }], error: null }),
    );
    const result = await getAverageRating('u1');
    expect(result.success).toBe(true);
    // 4+5 / 2 = 4.5
    expect(result.data).toBe(4.5);
  });

  it('returns 0 when all reviews are hidden/removed (empty result)', async () => {
    mockFrom.mockImplementation(() => chain({ data: [], error: null }));
    const result = await getAverageRating('u1');
    expect(result.success).toBe(true);
    expect(result.data).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('submitReview — original content preservation', () => {
  beforeEach(() => mockFrom.mockClear());

  const PAST_CHECKOUT = '2024-01-01T00:00:00.000Z';

  it('stores original_comment and original_rating alongside displayed fields', async () => {
    // First call: booking lookup
    mockFrom
      .mockImplementationOnce(() =>
        chain({
          data: { id: 'b1', status: 'Completed', check_out: PAST_CHECKOUT },
          error: null,
        }),
      )
      // Second call: insert
      .mockImplementation(() =>
        chain({
          data: {
            id: 'r1', booking_id: 'b1', reviewer_id: 'u1', target_id: 'u2',
            rating: 4, comment: 'Great place',
            original_rating: 4, original_comment: 'Great place',
          },
          error: null,
        }),
      );

    const result = await submitReview('b1', 'u1', 'u2', 4, 'Great place');
    expect(result.success).toBe(true);
    // Both displayed and original should be set to the submitted values
    expect(result.data!.original_rating).toBe(4);
    expect(result.data!.original_comment).toBe('Great place');
  });
});
