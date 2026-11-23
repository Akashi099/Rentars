/**
 * Distributed tracing HTTP middleware.
 *
 * Extracts trace context from incoming requests, creates server spans,
 * and injects trace context into outgoing responses.
 */

import { type Request, type Response, type NextFunction } from 'express';
import { extractTraceContext, injectTraceContext, runWithTraceContext, startSpan, endSpan, SpanKind } from '../config/tracing.js';
import { structuredLog } from './logging.middleware.js';

export interface TracedRequest extends Request {
  traceContext?: ReturnType<typeof extractTraceContext>;
  traceSpan?: ReturnType<typeof startSpan>;
  correlationId?: string;
  bookingId?: string;
  operationId?: string;
}

const SKIP_PATHS = new Set(['/health', '/metrics', '/favicon.ico', '/api/v1/client-errors']);

const CORRELATION_HEADER = 'x-correlation-id';
const BOOKING_HEADER = 'x-booking-id';
const OPERATION_HEADER = 'x-operation-id';

/**
 * Sanitize a user-supplied correlation value before it is logged or echoed.
 * Only short, opaque identifier characters are allowed; anything else is
 * dropped so secrets or free-form user input never reach logs.
 */
export function sanitizeCorrelationValue(value: unknown, maxLength = 128): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function readHeader(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return sanitizeCorrelationValue(value);
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path)) {
    next();
    return;
  }

  const incomingHeaders: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    incomingHeaders[key] = value;
  }

  const parentContext = extractTraceContext(incomingHeaders);
  const context = parentContext ?? {
    traceId: '',
    spanId: '',
    sampled: false,
  };

  if (!parentContext) {
    context.traceId = crypto.randomUUID();
    context.spanId = crypto.randomUUID();
    context.sampled = Math.random() < 0.1;
  }

  const correlationId = readHeader(req, CORRELATION_HEADER) ?? context.traceId;
  const bookingId = readHeader(req, BOOKING_HEADER);
  const operationId = readHeader(req, OPERATION_HEADER);

  const span = startSpan(`${req.method} ${req.path}`, SpanKind.SERVER, {
    'http.method': req.method,
    'http.route': req.path,
    'http.target': req.url,
    'http.scheme': req.protocol,
    'http.host': req.get('host') ?? '',
    'http.user_agent': req.get('user-agent') ?? '',
    'net.host.port': req.socket.localPort ?? 0,
    'net.peer.ip': req.ip ?? '',
    'correlation.id': correlationId,
    ...(bookingId ? { 'booking.id': bookingId } : {}),
    ...(operationId ? { 'operation.id': operationId } : {}),
  });

  const tracedReq = req as TracedRequest;
  tracedReq.traceContext = context;
  tracedReq.traceSpan = span;
  tracedReq.correlationId = correlationId;
  tracedReq.bookingId = bookingId;
  tracedReq.operationId = operationId;

  // Propagate correlation identifiers as trace baggage so downstream
  // spans, logs and deferred work share the same operation context.
  const baggage: Record<string, string> = { 'correlation.id': correlationId };
  if (bookingId) baggage['booking.id'] = bookingId;
  if (operationId) baggage['operation.id'] = operationId;
  (context as { baggage?: Record<string, string> }).baggage = {
    ...((context as { baggage?: Record<string, string> }).baggage ?? {}),
    ...baggage,
  };

  injectTraceContext(context, res.getHeaders() as Record<string, string>);
  res.setHeader(CORRELATION_HEADER, correlationId);
  if (bookingId) res.setHeader(BOOKING_HEADER, bookingId);
  if (operationId) res.setHeader(OPERATION_HEADER, operationId);

  runWithTraceContext(context, () => {
    res.on('finish', () => {
      if (span) {
        span.attributes['http.status_code'] = res.statusCode;
        if (res.statusCode >= 400) {
          span.status = { code: 'error', message: `HTTP ${res.statusCode}` };
        }
        endSpan(span);
      }
    });

    next();
  });
}

export function getRequestTraceContext(req: Request): ReturnType<typeof extractTraceContext> | undefined {
  return (req as TracedRequest).traceContext;
}

export function getRequestTraceId(req: Request): string | undefined {
  return (req as TracedRequest).traceContext?.traceId;
}

export function getRequestCorrelationId(req: Request): string | undefined {
  const traced = req as TracedRequest;
  return traced.correlationId ?? traced.traceContext?.traceId;
}

export function getRequestBookingId(req: Request): string | undefined {
  return (req as TracedRequest).bookingId;
}

export function getRequestOperationId(req: Request): string | undefined {
  return (req as TracedRequest).operationId;
}

/**
 * Build the correlation context that should be persisted with deferred work
 * (queue records, idempotency records, retry jobs) so workers can restore it.
 */
export function getRequestCorrelationContext(req: Request): {
  correlationId?: string;
  bookingId?: string;
  operationId?: string;
  traceId?: string;
  spanId?: string;
} {
  const traced = req as TracedRequest;
  return {
    correlationId: getRequestCorrelationId(req),
    bookingId: traced.bookingId,
    operationId: traced.operationId,
    traceId: traced.traceContext?.traceId,
    spanId: traced.traceContext?.spanId,
  };
}

export function createChildSpanFromRequest(req: Request, name: string, kind: SpanKind = 'internal', attributes?: Record<string, unknown>) {
  const traceContext = getRequestTraceContext(req);
  if (traceContext) {
    const traced = req as TracedRequest;
    const correlationAttributes: Record<string, unknown> = {
      'span.name': name,
      'span.kind': kind,
      'correlation.id': getRequestCorrelationId(req),
      ...(traced.bookingId ? { 'booking.id': traced.bookingId } : {}),
      ...(traced.operationId ? { 'operation.id': traced.operationId } : {}),
      ...(attributes ?? {}),
    };
    structuredLog('debug', 'child span created', correlationAttributes);
    return {
      traceId: traceContext.traceId,
      spanId: crypto.randomUUID(),
      parentSpanId: traceContext.spanId,
      sampled: traceContext.sampled,
      attributes: correlationAttributes,
    };
  }
  return undefined;
}