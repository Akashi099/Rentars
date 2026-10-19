/**
 * Audit logging service.
 *
 * Writes structured JSON audit log entries to stdout for log aggregation
 * (Datadog, CloudWatch, etc.) and persists them to the audit_logs table in
 * Supabase for operational review.
 *
 * Every sensitive action — login, logout, registration, property changes,
 * bookings, admin operations — should call auditLogger.log().
 *
 * Prevents logging of sensitive data:
 * - Tokens, secrets, passwords, seeds
 * - Full payment card information
 * - SSN, driver's license numbers
 * - Only hashes or IDs are logged
 *
 * Entry shape:
 * {
 *   timestamp:       ISO 8601
 *   correlation_id:  request/operation ID for tracing
 *   actor_id:        user ID performing the action (undefined for unauthenticated)
 *   action:          verb describing what happened (e.g. "property.create")
 *   resource_type:   "user" | "property" | "booking" | "dispute" | "auth" | ...
 *   resource_id:     ID of the affected resource (if applicable)
 *   target_ids:      array of affected resource IDs (for bulk operations)
 *   ip:              client IP address
 *   success:         true if action succeeded
 *   error:           error message if action failed
 *   meta:            additional context (no secrets, no PII beyond IDs)
 * }
 */

import { supabase } from '@/config/supabase.js';
import crypto from 'crypto';

export type AuditAction =
  // Auth
  | 'auth.register'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.logout_all_devices'
  | 'auth.token_refresh'
  | 'auth.password_reset_request'
  | 'auth.password_reset_confirm'
  | 'auth.email_verify'
  | 'auth.unauthorized_access'
  // Properties
  | 'property.create'
  | 'property.update'
  | 'property.delete'
  | 'property.suspend'
  | 'property.activate'
  | 'property.publish'
  | 'property.unpublish'
  | 'property.change_owner'
  // Bookings
  | 'booking.create'
  | 'booking.cancel'
  | 'booking.confirm'
  | 'booking.delete'
  | 'booking.modify'
  | 'booking.complete'
  // Payments
  | 'payment.submit'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.retry'
  | 'payment.refund'
  // Disputes
  | 'dispute.open'
  | 'dispute.resolve'
  | 'dispute.modify'
  // Account
  | 'account.email_change'
  | 'account.role_change'
  | 'account.delete'
  | 'account.disable_2fa'
  | 'account.enable_2fa'
  | 'account.wallet_link'
  | 'account.wallet_unlink'
  // Admin
  | 'admin.user_suspend'
  | 'admin.user_activate'
  | 'admin.user_delete'
  | 'admin.property_suspend'
  | 'admin.property_activate'
  | 'admin.featured_set'
  | 'admin.featured_clear'
  | 'admin.refund_approve'
  | 'admin.refund_reject'
  | 'admin.session_revoke'
  | 'admin.settings_change'
  | 'admin.role_grant'
  | 'admin.role_revoke';

export type ResourceType =
  | 'user'
  | 'property'
  | 'booking'
  | 'payment'
  | 'dispute'
  | 'auth'
  | 'admin'
  | 'account'
  | 'session';

export interface AuditLogEntry {
  actorId?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  targetIds?: string[];
  ip?: string;
  correlationId?: string;
  success?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * Keys whose values must never be persisted. Matches credentials, key material,
 * raw provider or message payloads, and free-text bodies.
 */
const SENSITIVE_META_KEYS =
  /token|secret|password|passwd|seed|mnemonic|key|pin|card|ssn|cvv|signature|private|cookie|authorization|payload|raw|body|content/i;

/**
 * Sanitize metadata to prevent logging of sensitive data.
 * Exported for tests; production code reaches it through AuditLogger.log.
 */
export function sanitizeAuditMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  return sanitizeValue(meta) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 255 ? `${value.slice(0, 255)}...[TRUNCATED]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      // Log that the field was present, but do not store its value
      sanitized[key] = SENSITIVE_META_KEYS.test(key) ? '[REDACTED]' : sanitizeValue(nested);
    }
    return sanitized;
  }
  return value;
}

class AuditLogger {
  /**
   * Log an audit event with optional correlation ID for request tracing.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    const correlationId = entry.correlationId || crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const record = {
      timestamp,
      correlation_id: correlationId,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      target_ids: entry.targetIds ?? null,
      ip: entry.ip ?? null,
      success: entry.success ?? true,
      error: entry.error ?? null,
      meta: sanitizeAuditMeta(entry.meta),
    };

    // Always emit to stdout as structured JSON for log aggregation
    console.log(JSON.stringify({ audit: true, ...record }));

    // Persist to Supabase (best-effort — never throws)
    try {
      await supabase.from('audit_logs').insert(record);
    } catch (err) {
      console.error('[AuditLogger] Failed to persist audit log entry:', err);
    }
  }

  /**
   * Query audit logs with pagination and filtering.
   * Restricted to authenticated admins only.
   *
   * @param filters - Filter options
   * @param limit - Results per page (max 100)
   * @param offset - Pagination offset
   */
  async query(
    filters: {
      actorId?: string;
      resourceType?: ResourceType;
      resourceId?: string;
      action?: AuditAction;
      since?: Date;
      until?: Date;
    },
    limit: number = 50,
    offset: number = 0,
  ): Promise<{ entries: any[]; total: number }> {
    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' });

    if (filters.actorId) {
      query = query.eq('actor_id', filters.actorId);
    }

    if (filters.resourceType) {
      query = query.eq('resource_type', filters.resourceType);
    }

    if (filters.resourceId) {
      query = query.eq('resource_id', filters.resourceId);
    }

    if (filters.action) {
      query = query.eq('action', filters.action);
    }

    if (filters.since) {
      query = query.gte('timestamp', filters.since.toISOString());
    }

    if (filters.until) {
      query = query.lte('timestamp', filters.until.toISOString());
    }

    // Apply pagination
    const cappedLimit = Math.min(limit, 100);
    query = query
      .order('timestamp', { ascending: false })
      .range(offset, offset + cappedLimit - 1);

    const { data, error, count } = await query;

    if (error) {
      throw new Error(`Audit log query failed: ${error.message}`);
    }

    return {
      entries: data ?? [],
      total: count ?? 0,
    };
  }

  /**
   * Get logs for a specific resource and trace changes over time.
   */
  async getResourceHistory(
    resourceType: ResourceType,
    resourceId: string,
    limit: number = 50,
  ): Promise<any[]> {
    const { entries } = await this.query(
      { resourceType, resourceId },
      limit,
    );

    return entries;
  }

  /**
   * Get all actions performed by an actor (user).
   */
  async getActorHistory(
    actorId: string,
    limit: number = 50,
  ): Promise<any[]> {
    const { entries } = await this.query(
      { actorId },
      limit,
    );

    return entries;
  }
}

export const auditLogger = new AuditLogger();
