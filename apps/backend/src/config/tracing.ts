/**
 * Distributed tracing configuration and context management.
 *
 * Implements W3C Trace Context standard for trace propagation.
 * Uses AsyncLocalStorage for context propagation within a request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { env } from '@/config/env.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
  baggage?: Record<string, string>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
}

export type SpanKind = 'server' | 'client' | 'producer' | 'consumer' | 'internal';

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export type SpanStatus = { code: 'ok' } | { code: 'error'; message: string };

const traceContextStorage = new AsyncLocalStorage<TraceContext>();
const spanStorage = new AsyncLocalStorage<Span>();

export function getTraceContext(): TraceContext | undefined {
  return traceContextStorage.getStore();
}

export function getCurrentSpan(): Span | undefined {
  return spanStorage.getStore();
}

export function runWithTraceContext<T>(context: TraceContext, callback: () => T): T {
  return traceContextStorage.run(context, callback);
}

export function runWithSpan<T>(span: Span, callback: () => T): T {
  return spanStorage.run(span, callback);
}

export function createTraceContext(
  parentContext?: TraceContext,
  forceSampled?: boolean,
): TraceContext {
  const sampled = forceSampled ?? shouldSample(parentContext);
  return {
    traceId: parentContext?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    parentSpanId: parentContext?.spanId,
    sampled,
    baggage: parentContext?.baggage,
  };
}

function shouldSample(parentContext?: TraceContext): boolean {
  if (parentContext?.sampled) return true;

  const sampleRate = env.TRACE_SAMPLE_RATE ?? 0.1;
  return Math.random() < sampleRate;
}

export function extractTraceContext(headers: Record<string, string | string[] | undefined>): TraceContext | undefined {
  const traceparent = getHeader(headers, 'traceparent');
  const tracestate = getHeader(headers, 'tracestate');

  if (!traceparent) return undefined;

  const parts = traceparent.split('-');
  if (parts.length < 3) return undefined;

  const [version, traceId, parentSpanId, flags] = parts;
  if (version !== '00') return undefined;

  const sampled = (parseInt(flags, 16) & 1) === 1;

  return {
    traceId,
    spanId: randomUUID(),
    parentSpanId,
    sampled,
    baggage: parseTracestate(tracestate),
  };
}

export function injectTraceContext(context: TraceContext, headers: Record<string, string>): void {
  headers['traceparent'] = `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
  if (context.baggage && Object.keys(context.baggage).length > 0) {
    headers['tracestate'] = Object.entries(context.baggage)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseTracestate(tracestate?: string): Record<string, string> | undefined {
  if (!tracestate) return undefined;
  const result: Record<string, string> = {};
  for (const pair of tracestate.split(',')) {
    const [k, v] = pair.split('=', 2);
    if (k && v) result[k.trim()] = v.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function startSpan(
  name: string,
  kind: SpanKind = 'internal',
  attributes: Record<string, unknown> = {},
): Span {
  const parentContext = getTraceContext();
  const context = createTraceContext(parentContext);

  const span: Span = {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    name,
    kind,
    startTime: performance.now(),
    attributes: {
      ...attributes,
      'service.name': 'rentars-api',
      'service.version': env.DEPLOYMENT_VERSION ?? 'unknown',
    },
    events: [],
    status: { code: 'ok' },
  };

  return span;
}

export function endSpan(span: Span, status: SpanStatus = { code: 'ok' }): void {
  span.endTime = performance.now();
  span.status = status;
  exportSpan(span);
}

export function addSpanAttribute(key: string, value: unknown): void {
  const span = getCurrentSpan();
  if (span) span.attributes[key] = value;
}

export function addSpanEvent(name: string, attributes?: Record<string, unknown>): void {
  const span = getCurrentSpan();
  if (span) {
    span.events.push({
      name,
      timestamp: performance.now(),
      attributes,
    });
  }
}

export function recordSpanError(error: Error): void {
  const span = getCurrentSpan();
  if (span) {
    span.status = { code: 'error', message: error.message };
    span.attributes['error.type'] = error.name;
    span.attributes['error.message'] = error.message;
    span.attributes['error.stack'] = error.stack;
  }
}

function exportSpan(span: Span): void {
  if (!span.sampled) return;

  const durationMs = (span.endTime ?? performance.now()) - span.startTime;

  const sanitizedAttributes = sanitizeAttributes(span.attributes);

  const logEntry = {
    level: span.status.code === 'error' ? 'error' : 'info',
    message: `Span completed: ${span.name}`,
    timestamp: new Date().toISOString(),
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: span.kind,
    durationMs,
    status: span.status,
    attributes: sanitizedAttributes,
    events: span.events,
  };

  if (span.status.code === 'error') {
    console.error(JSON.stringify(logEntry));
  } else {
    console.log(JSON.stringify(logEntry));
  }
}

function sanitizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'authorization',
    'cookie',
    'session',
    'jwt',
    'api_key',
    'apikey',
    'access_token',
    'refresh_token',
    'stellar_secret',
    'private_key',
    'mnemonic',
  ];

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(attrs)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveKeys.some((sk) => lowerKey.includes(sk));

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }

  return result;
}

export function createChildSpan(name: string, kind: SpanKind = 'internal', attributes: Record<string, unknown> = {}): Span {
  const currentSpan = getCurrentSpan();
  const parentContext = getTraceContext();

  const context: TraceContext = {
    traceId: currentSpan?.traceId ?? parentContext?.traceId ?? randomUUID(),
    spanId: randomUUID(),
    parentSpanId: currentSpan?.spanId ?? parentContext?.spanId,
    sampled: currentSpan !== undefined || parentContext?.sampled ?? false,
  };

  const span: Span = {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    name,
    kind,
    startTime: performance.now(),
    attributes: {
      ...attributes,
      'service.name': 'rentars-api',
      'service.version': env.DEPLOYMENT_VERSION ?? 'unknown',
    },
    events: [],
    status: { code: 'ok' },
  };

  return span;
}

export function withSpan<T>(name: string, kind: SpanKind, fn: () => Promise<T>, attributes?: Record<string, unknown>): Promise<T> {
  const span = startSpan(name, kind, attributes);
  return runWithSpan(span, async () => {
    try {
      const result = await fn();
      endSpan(span);
      return result;
    } catch (err) {
      recordSpanError(err instanceof Error ? err : new Error(String(err)));
      endSpan(span, { code: 'error', message: String(err) });
      throw err;
    }
  });
}