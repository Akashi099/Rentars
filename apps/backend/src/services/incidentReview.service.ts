/**
 * Incident Review Service (Issue #110)
 *
 * Production incident review process for incidents involving payments,
 * booking integrity, account security, or availability.
 *
 * Covers: severity levels, communication roles (incident commander /
 * technical lead), timeline capture, impact assessment, cause analysis,
 * customer follow-up, action tracking, alert/release linkage, sensitive
 * evidence redaction, and operational-cadence action review.
 *
 * Pure functions — no DB/network I/O — so reviews can be built, validated,
 * and redacted anywhere (API, CLI, tests) before persistence.
 */

export type IncidentSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';

export const SEVERITY_LEVELS: Record<
  IncidentSeverity,
  { label: string; responseSlaMin: number; reviewRequired: boolean }
> = {
  SEV1: { label: 'Critical', responseSlaMin: 15, reviewRequired: true },
  SEV2: { label: 'High', responseSlaMin: 60, reviewRequired: true },
  SEV3: { label: 'Medium', responseSlaMin: 240, reviewRequired: true },
  SEV4: { label: 'Low', responseSlaMin: 1440, reviewRequired: false },
};

export type IncidentCategory =
  | 'payments'
  | 'booking_integrity'
  | 'account_security'
  | 'availability'
  | 'other';

export interface TimelineEntry {
  at: string; // ISO-8601 UTC
  actor: string; // commander, tech lead, system, comms
  event: string;
}

export interface FollowUpAction {
  id: string;
  title: string;
  owner: string;
  dueDate: string; // ISO date
  status: 'open' | 'in_progress' | 'done';
}

export interface IncidentReview {
  id: string;
  title: string;
  severity: IncidentSeverity;
  category: IncidentCategory;
  commander: string; // incident commander user id
  technicalLead: string; // technical lead user id
  detectedAt: string;
  mitigatedAt?: string;
  resolvedAt?: string;
  impact: string;
  detection: string;
  response: string;
  contributingFactors: string[];
  customerFollowUp?: string;
  alertIds: string[];
  releaseIds: string[];
  actions: FollowUpAction[];
}

/** Fields every qualifying review must contain (acceptance criteria). */
const REQUIRED_TEXT_FIELDS = [
  'impact',
  'detection',
  'response',
] as const;

export function qualifiesForReview(
  severity: IncidentSeverity,
  category: IncidentCategory,
): boolean {
  if (SEVERITY_LEVELS[severity].reviewRequired) return true;
  return (
    category === 'payments' ||
    category === 'booking_integrity' ||
    category === 'account_security' ||
    category === 'availability'
  );
}

export function validateReview(review: IncidentReview): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!review[field] || review[field].trim().length === 0) {
      errors.push(`Missing required section: ${field}.`);
    }
  }
  if (!review.commander?.trim()) errors.push('Incident commander is required.');
  if (!review.technicalLead?.trim())
    errors.push('Technical lead is required.');
  if (review.contributingFactors.length === 0) {
    errors.push('At least one contributing factor is required.');
  }
  const withoutOwner = review.actions.filter((a) => !a.owner?.trim());
  if (withoutOwner.length > 0) {
    errors.push(
      `${withoutOwner.length} follow-up action(s) have no owner.`,
    );
  }
  return errors;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /sk_live_[A-Za-z0-9]+/g,
  /xdr_[A-Za-z0-9_-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // emails → redact in shared reviews
];

/**
 * Redacts sensitive evidence (keys, secrets, PII) from free-text evidence
 * before it is stored in or shared from a review.
 */
export function redactEvidence(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function openActions(review: IncidentReview): FollowUpAction[] {
  return review.actions.filter((a) => a.status !== 'done');
}

/** Completion rate of follow-up actions, 0–1. Used for operational-cadence review. */
export function actionCompletionRate(review: IncidentReview): number {
  if (review.actions.length === 0) return 1;
  const done = review.actions.filter((a) => a.status === 'done').length;
  return done / review.actions.length;
}
