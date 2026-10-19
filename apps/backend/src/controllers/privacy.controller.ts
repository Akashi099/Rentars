/**
 * Request handlers for the privacy (data subject rights) endpoints.
 *
 * Kept free of middleware and env imports so the handlers can be unit-tested
 * directly. Routing, authentication and rate limiting live in privacy.routes.ts.
 */

import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  cancelAccountDeletion,
  DeletionBlockedError,
  getDataExportStatus,
  getDeletionRequest,
  processDataExport,
  requestAccountDeletion,
  requestDataExport,
  verifyUserPassword,
} from '@/services/privacy.service.js';

/** Exact phrase the client must send to confirm an irreversible action. */
export const DELETION_CONFIRMATION = 'DELETE MY ACCOUNT';

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'Unauthorized' });
}

export async function startExport(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const request = await requestDataExport(userId, req.ip ?? 'unknown');

  void processDataExport(userId, request.id).catch((err: unknown) => {
    console.error(
      '[privacy] export generation crashed',
      request.id,
      err instanceof Error ? err.message : err
    );
  });

  res.status(202).json({
    export_id: request.id,
    status: request.status,
    expires_at: request.expires_at,
    poll_url: `/api/v1/privacy/export/${request.id}`,
  });
}

export async function getExport(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const exportRecord = await getDataExportStatus(userId, req.params.exportId as string);
  if (!exportRecord) {
    res.status(404).json({ error: 'Export not found' });
    return;
  }

  if (exportRecord.status === 'pending') {
    res.status(202).json({ export_id: exportRecord.id, status: 'pending' });
    return;
  }

  if (exportRecord.status === 'failed') {
    res.status(500).json({
      export_id: exportRecord.id,
      status: 'failed',
      error: 'Export generation failed. Please request a new export.',
    });
    return;
  }

  if (new Date(exportRecord.expires_at) < new Date()) {
    res.status(410).json({ error: 'Export has expired. Please request a new export.' });
    return;
  }

  res.json({
    export_id: exportRecord.id,
    status: exportRecord.status,
    expires_at: exportRecord.expires_at,
    data: exportRecord.export_payload ?? null,
  });
}

/**
 * Body: { password: string, confirmation: "DELETE MY ACCOUNT" }
 *
 * Re-verifies the password, refuses (409) while the user has open bookings,
 * escrow or disputes, and otherwise opens a 7-day cancellation window.
 */
export async function requestDeletion(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const { password, confirmation } = (req.body ?? {}) as {
    password?: unknown;
    confirmation?: unknown;
  };

  if (confirmation !== DELETION_CONFIRMATION) {
    res.status(400).json({ error: `Send confirmation: "${DELETION_CONFIRMATION}"` });
    return;
  }

  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'Password is required to delete your account' });
    return;
  }

  if (!(await verifyUserPassword(userId, password))) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  try {
    const deletion = await requestAccountDeletion(userId, req.ip ?? 'unknown');
    res.status(202).json({
      deletion_id: deletion.id,
      status: deletion.status,
      cancel_expires_at: deletion.cancel_expires_at,
      message:
        'Your account will be anonymised when the cancellation window closes. You can cancel until then.',
      retained_data: [
        'Booking and payment records (7-year legal retention)',
        'Audit log entries (7-year legal retention)',
        'Blockchain records on the Stellar ledger (permanent — cannot be deleted)',
      ],
    });
  } catch (err) {
    if (err instanceof DeletionBlockedError) {
      res.status(409).json({
        error:
          'Account deletion is blocked by open bookings or disputes. Resolve them and try again.',
        code: err.code,
        open_bookings: err.obligations.map((o) => ({
          booking_id: o.booking_id,
          status: o.status,
          role: o.role,
        })),
      });
      return;
    }
    console.error('[privacy] deletion request failed', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Could not start account deletion. Please try again.' });
  }
}

export async function getDeletion(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const deletion = await getDeletionRequest(userId, req.params.deletionId as string);
  if (!deletion) {
    res.status(404).json({ error: 'Deletion request not found' });
    return;
  }

  res.json({
    deletion_id: deletion.id,
    status: deletion.status,
    requested_at: deletion.requested_at,
    cancel_expires_at: deletion.cancel_expires_at,
    completed_at: deletion.completed_at ?? null,
    last_blocked_reason: deletion.last_blocked_reason ?? null,
  });
}

export async function cancelDeletion(req: AuthRequest, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) return unauthorized(res);

  const cancelled = await cancelAccountDeletion(
    userId,
    req.params.deletionId as string,
    req.ip ?? 'unknown'
  );
  if (!cancelled) {
    res
      .status(409)
      .json({ error: 'Deletion cannot be cancelled (not pending, or the window has closed)' });
    return;
  }

  res.json({ status: 'cancelled' });
}
