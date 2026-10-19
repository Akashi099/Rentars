import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth.middleware.js';
import { submitReport, listReports, resolveReport } from '../services/report.service.js';
import type { ReportStatus, ReportTargetType } from '../services/report.service.js';

export async function createReport(req: AuthRequest, res: Response): Promise<void> {
  const reporterId = req.userId;
  if (!reporterId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { targetType, targetId, reason, details } = req.body;
  const result = await submitReport(reporterId, targetType, targetId, reason, details);

  if (!result.success) {
    res.status(result.conflict ? 409 : (result.statusCode ?? 400)).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function listReportsHandler(req: AuthRequest, res: Response): Promise<void> {
  const status = req.query.status as ReportStatus | undefined;
  const targetType = req.query.targetType as ReportTargetType | undefined;

  const result = await listReports({ status, targetType });

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function resolveReportHandler(req: AuthRequest, res: Response): Promise<void> {
  const resolverId = req.userId;
  if (!resolverId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { status, resolutionNote } = req.body;
  const result = await resolveReport(req.params.id, resolverId, status, resolutionNote);

  if (!result.success) {
    res.status(result.error === 'Report not found' ? 404 : 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

// ─── Moderation Workflow ──────────────────────────────────────────────────────

export async function assignReportHandler(req: AuthRequest, res: Response): Promise<void> {
  const { moderatorId } = req.body;
  if (!moderatorId) {
    res.status(400).json({ error: 'moderatorId is required' });
    return;
  }

  const { assignReport } = await import('../services/report.service.js');
  const result = await assignReport(req.params.id, moderatorId);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function setSeverityHandler(req: AuthRequest, res: Response): Promise<void> {
  const { severity } = req.body;
  if (!severity) {
    res.status(400).json({ error: 'severity is required' });
    return;
  }

  const { setSeverity } = await import('../services/report.service.js');
  const result = await setSeverity(req.params.id, severity);

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function addEvidenceHandler(req: AuthRequest, res: Response): Promise<void> {
  const { type, url, description } = req.body;
  if (!type || !url) {
    res.status(400).json({ error: 'type and url are required' });
    return;
  }

  const { addEvidence } = await import('../services/report.service.js');
  const result = await addEvidence(req.params.id, { type, url, description });

  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function hidePropertyHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { hideProperty } = await import('../services/report.service.js');
  const result = await hideProperty(req.params.id, moderatorId);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function unhidePropertyHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { unhideProperty } = await import('../services/report.service.js');
  const result = await unhideProperty(req.params.id, moderatorId);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function escalateReportHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { escalateReport } = await import('../services/report.service.js');
  const result = await escalateReport(req.params.id as string, moderatorId, req.body?.note);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function submitAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  const hostId = req.userId;
  if (!hostId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { appealReason } = req.body;
  if (!appealReason || typeof appealReason !== 'string') {
    res.status(400).json({ error: 'appealReason is required' });
    return;
  }

  const { submitAppeal } = await import('../services/report.service.js');
  const result = await submitAppeal(req.params.id, hostId, appealReason);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function reviewAppealHandler(req: AuthRequest, res: Response): Promise<void> {
  const moderatorId = req.userId;
  if (!moderatorId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { approved } = req.body;
  if (typeof approved !== 'boolean') {
    res.status(400).json({ error: 'approved (boolean) is required' });
    return;
  }

  const { reviewAppeal } = await import('../services/report.service.js');
  const result = await reviewAppeal(req.params.id, moderatorId, approved);

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error });
    return;
  }

  res.json(result.data);
}

export async function getReportImpactHandler(req: AuthRequest, res: Response): Promise<void> {
  const { targetType, targetId } = req.query;
  if (!targetType || !targetId) {
    res.status(400).json({ error: 'targetType and targetId are required' });
    return;
  }

  const { getReportImpact } = await import('../services/report.service.js');
  const result = await getReportImpact(
    targetType as string,
    targetId as string,
  );

  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json(result.data);
}
