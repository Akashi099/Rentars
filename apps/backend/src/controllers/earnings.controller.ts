import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { EarningsService } from '@/services/earnings.service.js';
import {
  getHostLedgerBalance,
  listLedgerEntries,
  reconcileHostLedger,
  postAdjustment,
  type LedgerDirection,
} from '@/services/ledger.service.js';

const earningsService = new EarningsService();

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/;

function validateDateParams(
  from: unknown,
  to: unknown,
): { from: string; to: string } | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return null;
  return { from, to };
}

/**
 * GET /api/v1/host/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns gross, platform_fees, net, pending, and released earnings for the
 * authenticated host over the requested date range.
 */
export async function getHostEarnings(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to) {
    res.status(422).json({ error: 'from and to query parameters are required (YYYY-MM-DD)' });
    return;
  }

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(from) || !dateRe.test(to)) {
    res.status(422).json({ error: 'from and to must be valid dates in YYYY-MM-DD format' });
    return;
  }

  const result = await earningsService.getHostEarnings(hostId, from, to);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/host/ledger?from=&to=&currency=USDC&page=1&limit=50
 *
 * Returns paginated append-only ledger entries for the authenticated host.
 */
export async function getLedgerEntries(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
  };

  const dates = validateDateParams(from, to);
  if (!dates) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }

  const page  = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));

  const result = await listLedgerEntries(
    hostId,
    { from: dates.from, to: dates.to, currency: currency === 'USDC' ? 'USDC' : undefined },
    page,
    limit,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/host/ledger/balance?from=&to=&currency=USDC
 *
 * Returns the derived balance (credits − debits) for the authenticated host
 * over the requested period.  Balances are derived from source events rather
 * than a mutable summary column.
 */
export async function getLedgerBalance(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
  };

  const dates = validateDateParams(from, to);
  if (!dates) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }

  const result = await getHostLedgerBalance(
    hostId,
    { from: dates.from, to: dates.to, currency: currency === 'USDC' ? 'USDC' : undefined },
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * GET /api/v1/host/ledger/reconcile?from=&to=&currency=USDC
 *
 * Runs a reconciliation check comparing the ledger net against settled booking
 * totals.  Returns a drift value and a reconciled flag.
 */
export async function getReconciliationReport(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { from, to, currency } = req.query as {
    from?: string;
    to?: string;
    currency?: string;
  };

  const dates = validateDateParams(from, to);
  if (!dates) {
    res.status(422).json({ error: 'from and to are required (YYYY-MM-DD or ISO-8601)' });
    return;
  }

  const result = await reconcileHostLedger(
    hostId,
    { from: dates.from, to: dates.to, currency: currency === 'USDC' ? 'USDC' : undefined },
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

/**
 * POST /api/v1/admin/host/:hostId/ledger/adjustment
 *
 * Ops-only: post an auditable adjustment entry instead of editing history.
 * Body: { direction: 'credit'|'debit', amount: number, adminNote: string, bookingId?: string }
 */
export async function postLedgerAdjustment(req: AuthRequest, res: Response): Promise<void> {
  const adminId = req.userId;
  if (!adminId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hostId } = req.params;
  const { direction, amount, adminNote, bookingId } = req.body as {
    direction?: unknown;
    amount?: unknown;
    adminNote?: unknown;
    bookingId?: unknown;
  };

  if (direction !== 'credit' && direction !== 'debit') {
    res.status(422).json({ error: 'direction must be "credit" or "debit"' });
    return;
  }

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0) {
    res.status(422).json({ error: 'amount must be a positive finite number' });
    return;
  }

  if (typeof adminNote !== 'string' || !adminNote.trim()) {
    res.status(422).json({ error: 'adminNote is required for adjustments' });
    return;
  }

  const result = await postAdjustment(
    hostId,
    direction as LedgerDirection,
    numAmount,
    adminId,
    adminNote,
    typeof bookingId === 'string' ? bookingId : undefined,
  );

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data ?? { message: 'Duplicate adjustment — no new entry created' });
}
