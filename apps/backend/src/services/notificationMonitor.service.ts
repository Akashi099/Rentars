/**
 * Notification Monitor Service
 *
 * Provides observability metrics for the notification delivery pipeline:
 *
 *  - recordDeliveryAttempt()  — called by notification workers before sending
 *  - updateDeliveryOutcome()  — called after send completes (success or failure)
 *  - rollupHourlyStats()      — aggregates raw log into notification_channel_stats
 *  - getDashboardMetrics()    — admin dashboard: queue depth, latency, failure rates
 *  - getChannelBreakdown()    — failure counts grouped by channel + template
 *  - getRetryBacklog()        — records pending retry past their scheduled time
 *
 * Payloads (message content) are never stored or returned.
 * User IDs are stored only for retention-policy targeting and never exposed
 * in aggregated dashboard responses.
 */

import { supabase } from '../config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type NotificationChannel = 'in_app' | 'email' | 'push';
export type NotificationDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'suppressed'
  | 'skipped';

export type FailureCategory =
  | 'provider_unavailable'
  | 'rate_limited'
  | 'invalid_token'
  | 'suppressed'
  | 'timeout'
  | 'unknown';

export interface DeliveryLogRecord {
  id: string;
  notification_id: string | null;
  user_id: string | null;
  notification_type: string;
  channel: NotificationChannel;
  template_key: string | null;
  enqueued_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  queue_latency_ms: number | null;
  delivery_latency_ms: number | null;
  status: NotificationDeliveryStatus;
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  failure_category: FailureCategory | null;
}

export interface DashboardMetrics {
  windowHours: number;
  since: string;
  queueDepth: number;              // records in 'queued' state
  totalSent: number;
  totalDelivered: number;
  totalFailed: number;
  totalSuppressed: number;
  overallFailureRate: number;      // 0.0 – 1.0
  avgQueueLatencyMs: number | null;
  avgDeliveryLatencyMs: number | null;
  retryBacklogCount: number;       // queued records past their next_retry_at
  byChannel: ChannelMetrics[];
}

export interface ChannelMetrics {
  channel: NotificationChannel;
  sent: number;
  delivered: number;
  failed: number;
  suppressed: number;
  failureRate: number;
  avgQueueLatencyMs: number | null;
}

export interface FailureBreakdownRow {
  channel: NotificationChannel;
  notification_type: string;
  failure_category: FailureCategory | null;
  count: number;
}

export interface RetryBacklogRow {
  id: string;
  notification_type: string;
  channel: NotificationChannel;
  attempt_count: number;
  next_retry_at: string;
  last_error: string | null;
}

// ─── Recording ────────────────────────────────────────────────────────────────

export interface RecordAttemptInput {
  notificationId?: string;
  userId?: string;
  notificationType: string;
  channel: NotificationChannel;
  templateKey?: string;
}

/**
 * Insert a delivery log record in the 'queued' state.
 * Returns the record ID so the caller can later call updateDeliveryOutcome().
 */
export async function recordDeliveryAttempt(
  input: RecordAttemptInput,
): Promise<ServiceResponse<string>> {
  const { data, error } = await supabase
    .from('notification_delivery_log')
    .insert({
      notification_id: input.notificationId ?? null,
      user_id: input.userId ?? null,
      notification_type: input.notificationType,
      channel: input.channel,
      template_key: input.templateKey ?? null,
      status: 'queued',
      attempt_count: 1,
    })
    .select('id')
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data as { id: string }).id };
}

export interface UpdateOutcomeInput {
  logId: string;
  status: NotificationDeliveryStatus;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
  lastError?: string;
  failureCategory?: FailureCategory;
  nextRetryAt?: string | null;
}

/**
 * Update the delivery outcome for a previously queued record.
 * Computes and stores queue/delivery latency automatically.
 */
export async function updateDeliveryOutcome(input: UpdateOutcomeInput): Promise<ServiceResponse<void>> {
  // Fetch enqueued_at so we can compute latencies
  const { data: existing, error: fetchError } = await supabase
    .from('notification_delivery_log')
    .select('enqueued_at, sent_at')
    .eq('id', input.logId)
    .single();

  if (fetchError || !existing) {
    return { success: false, error: fetchError?.message ?? 'Record not found' };
  }

  const row = existing as { enqueued_at: string; sent_at: string | null };
  const now = new Date();
  const sentAt = input.sentAt ? new Date(input.sentAt) : (input.status !== 'queued' ? now : null);

  const queueLatencyMs = sentAt
    ? sentAt.getTime() - new Date(row.enqueued_at).getTime()
    : null;

  const deliveryLatencyMs =
    input.deliveredAt && sentAt
      ? new Date(input.deliveredAt).getTime() - sentAt.getTime()
      : null;

  const { error } = await supabase
    .from('notification_delivery_log')
    .update({
      status: input.status,
      sent_at: input.sentAt ?? (sentAt ? sentAt.toISOString() : null),
      delivered_at: input.deliveredAt ?? null,
      failed_at: input.failedAt ?? (input.status === 'failed' ? now.toISOString() : null),
      queue_latency_ms: queueLatencyMs,
      delivery_latency_ms: deliveryLatencyMs,
      last_error: input.lastError ?? null,
      failure_category: input.failureCategory ?? null,
      next_retry_at: input.nextRetryAt ?? null,
    })
    .eq('id', input.logId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Roll up raw delivery log rows into notification_channel_stats for the given hour.
 * Called by a scheduled job; also called on-demand when the dashboard detects
 * the last rollup is stale.
 *
 * @param hourBucket - ISO timestamp truncated to the hour, e.g. "2026-10-16T14:00:00Z"
 */
export async function rollupHourlyStats(hourBucket: string): Promise<ServiceResponse<void>> {
  const hourStart = new Date(hourBucket);
  const hourEnd = new Date(hourStart.getTime() + 3_600_000);

  const { data, error } = await supabase
    .from('notification_delivery_log')
    .select(
      'channel, notification_type, status, queue_latency_ms, delivery_latency_ms, attempt_count',
    )
    .gte('enqueued_at', hourStart.toISOString())
    .lt('enqueued_at', hourEnd.toISOString());

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as Array<{
    channel: NotificationChannel;
    notification_type: string;
    status: NotificationDeliveryStatus;
    queue_latency_ms: number | null;
    delivery_latency_ms: number | null;
    attempt_count: number;
  }>;

  // Aggregate by (channel, notification_type)
  const buckets = new Map<
    string,
    {
      channel: NotificationChannel;
      notification_type: string;
      sent: number; delivered: number; failed: number; suppressed: number; retries: number;
      queueLatencies: number[]; deliveryLatencies: number[];
      emailBounced: number;
    }
  >();

  for (const row of rows) {
    const key = `${row.channel}::${row.notification_type}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        channel: row.channel,
        notification_type: row.notification_type,
        sent: 0, delivered: 0, failed: 0, suppressed: 0, retries: 0,
        queueLatencies: [], deliveryLatencies: [],
        emailBounced: 0,
      });
    }
    const b = buckets.get(key)!;

    if (row.status === 'sent' || row.status === 'delivered') b.sent++;
    if (row.status === 'delivered') b.delivered++;
    if (row.status === 'failed') b.failed++;
    if (row.status === 'suppressed') b.suppressed++;
    if (row.attempt_count > 1) b.retries++;
    if (row.queue_latency_ms !== null) b.queueLatencies.push(row.queue_latency_ms);
    if (row.delivery_latency_ms !== null) b.deliveryLatencies.push(row.delivery_latency_ms);
  }

  for (const bucket of buckets.values()) {
    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((s, n) => s + n, 0) / arr.length : null;

    const p95 = (arr: number[]) => {
      if (arr.length === 0) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.ceil(sorted.length * 0.95) - 1;
      return sorted[Math.max(0, idx)] ?? null;
    };

    const total = bucket.sent + bucket.failed + bucket.suppressed;
    const bounceRate =
      bucket.channel === 'email' && total > 0
        ? (bucket.emailBounced + bucket.failed) / total
        : null;

    await supabase.from('notification_channel_stats').upsert(
      {
        hour_bucket: hourBucket,
        channel: bucket.channel,
        notification_type: bucket.notification_type,
        sent_count: bucket.sent,
        delivered_count: bucket.delivered,
        failed_count: bucket.failed,
        suppressed_count: bucket.suppressed,
        retry_count: bucket.retries,
        avg_queue_latency_ms: avg(bucket.queueLatencies),
        avg_delivery_latency_ms: avg(bucket.deliveryLatencies),
        p95_queue_latency_ms: p95(bucket.queueLatencies),
        bounce_rate: bounceRate,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'hour_bucket,channel,notification_type' },
    );
  }

  return { success: true };
}

// ─── Dashboard queries ────────────────────────────────────────────────────────

/**
 * Compute dashboard metrics from the raw delivery log over the given window.
 * For windows longer than 2 hours the pre-aggregated stats table is preferred.
 */
export async function getDashboardMetrics(
  windowHours = 24,
): Promise<ServiceResponse<DashboardMetrics>> {
  const since = new Date(Date.now() - windowHours * 3_600_000);
  const sinceISO = since.toISOString();

  const [rawResult, retryBacklogResult] = await Promise.all([
    supabase
      .from('notification_delivery_log')
      .select('channel, status, queue_latency_ms, delivery_latency_ms')
      .gte('enqueued_at', sinceISO),
    supabase
      .from('notification_delivery_log')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued')
      .lte('next_retry_at', new Date().toISOString()),
  ]);

  if (rawResult.error) return { success: false, error: rawResult.error.message };

  const rows = (rawResult.data ?? []) as Array<{
    channel: NotificationChannel;
    status: NotificationDeliveryStatus;
    queue_latency_ms: number | null;
    delivery_latency_ms: number | null;
  }>;

  let totalSent = 0, totalDelivered = 0, totalFailed = 0, totalSuppressed = 0, queueDepth = 0;
  const allQueueLatencies: number[] = [];
  const allDeliveryLatencies: number[] = [];

  const channelMap = new Map<
    NotificationChannel,
    { sent: number; delivered: number; failed: number; suppressed: number; queueLatencies: number[] }
  >();

  for (const row of rows) {
    if (row.status === 'queued') { queueDepth++; continue; }
    if (row.status === 'sent' || row.status === 'delivered') totalSent++;
    if (row.status === 'delivered') totalDelivered++;
    if (row.status === 'failed') totalFailed++;
    if (row.status === 'suppressed') totalSuppressed++;

    if (row.queue_latency_ms !== null) allQueueLatencies.push(row.queue_latency_ms);
    if (row.delivery_latency_ms !== null) allDeliveryLatencies.push(row.delivery_latency_ms);

    if (!channelMap.has(row.channel)) {
      channelMap.set(row.channel, { sent: 0, delivered: 0, failed: 0, suppressed: 0, queueLatencies: [] });
    }
    const ch = channelMap.get(row.channel)!;
    if (row.status === 'sent' || row.status === 'delivered') ch.sent++;
    if (row.status === 'delivered') ch.delivered++;
    if (row.status === 'failed') ch.failed++;
    if (row.status === 'suppressed') ch.suppressed++;
    if (row.queue_latency_ms !== null) ch.queueLatencies.push(row.queue_latency_ms);
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : null;

  const byChannel: ChannelMetrics[] = Array.from(channelMap.entries()).map(([channel, m]) => ({
    channel,
    sent: m.sent,
    delivered: m.delivered,
    failed: m.failed,
    suppressed: m.suppressed,
    failureRate: m.sent + m.failed > 0 ? m.failed / (m.sent + m.failed) : 0,
    avgQueueLatencyMs: avg(m.queueLatencies),
  }));

  const overallTotal = totalSent + totalFailed + totalSuppressed;

  return {
    success: true,
    data: {
      windowHours,
      since: sinceISO,
      queueDepth,
      totalSent,
      totalDelivered,
      totalFailed,
      totalSuppressed,
      overallFailureRate: overallTotal > 0 ? totalFailed / overallTotal : 0,
      avgQueueLatencyMs: avg(allQueueLatencies),
      avgDeliveryLatencyMs: avg(allDeliveryLatencies),
      retryBacklogCount: retryBacklogResult.count ?? 0,
      byChannel,
    },
  };
}

/**
 * Returns failure counts grouped by (channel, notification_type, failure_category).
 * Used to identify which channel + template combination is failing.
 */
export async function getChannelBreakdown(
  windowHours = 24,
): Promise<ServiceResponse<FailureBreakdownRow[]>> {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const { data, error } = await supabase
    .from('notification_delivery_log')
    .select('channel, notification_type, failure_category')
    .eq('status', 'failed')
    .gte('enqueued_at', since);

  if (error) return { success: false, error: error.message };

  // Aggregate client-side to avoid a raw SQL GROUP BY
  const counts = new Map<string, FailureBreakdownRow>();
  for (const row of (data ?? []) as Array<{
    channel: NotificationChannel;
    notification_type: string;
    failure_category: FailureCategory | null;
  }>) {
    const key = `${row.channel}::${row.notification_type}::${row.failure_category ?? 'unknown'}`;
    if (!counts.has(key)) {
      counts.set(key, {
        channel: row.channel,
        notification_type: row.notification_type,
        failure_category: row.failure_category,
        count: 0,
      });
    }
    counts.get(key)!.count++;
  }

  return {
    success: true,
    data: Array.from(counts.values()).sort((a, b) => b.count - a.count),
  };
}

/**
 * Returns delivery log records that are scheduled for retry but haven't
 * been picked up yet (i.e., next_retry_at is in the past and status is 'queued').
 */
export async function getRetryBacklog(limit = 50): Promise<ServiceResponse<RetryBacklogRow[]>> {
  const { data, error } = await supabase
    .from('notification_delivery_log')
    .select('id, notification_type, channel, attempt_count, next_retry_at, last_error')
    .eq('status', 'queued')
    .not('next_retry_at', 'is', null)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(Math.min(limit, 200));

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as RetryBacklogRow[] };
}
