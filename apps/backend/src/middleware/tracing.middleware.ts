/**
 * Distributed tracing HTTP middleware.
 *
 * Extracts trace context from incoming requests, creates server spans,
 * and injects trace context into outgoing responses.
 */

import { type Request, type Response, type NextFunction } from 'express';
import { extractTraceContext, injectTraceContext, runWithTraceContext, startSpan, endSpan, getTraceContext, SpanKind } from './config/tracing.js';
import { structuredLog } from './middleware/logging.middleware.js';

export interface TracedRequest extends Request {
  traceContext?: ReturnType<typeof extractTraceContext>;
  traceSpan?: ReturnType<typeof startSpan>;
}

const SKIP_PATHS = new Set(['/health', '/metrics', '/favicon.ico', '/api/v1/client-errors']);

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

  const span = startSpan(`${req.method} ${req.path}`, SpanKind.SERVER, {
    'http.method': req.method,
    'http.route': req.path,
    'http.target': req.url,
    'http.scheme': req.protocol,
    'http.host': req.get('host') ?? '',
    'http.user_agent': req.get('user-agent') ?? '',
    'net.host.port': req.socket.localPort ?? 0,
    'net.peer.ip': req.ip ?? '',
  });

  (req as TracedRequest).traceContext = context;
  (req as TracedRequest).traceSpan = span;

  injectTraceContext(context, res.getHeaders() as Record<string, string>);

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

export function createChildSpanFromRequest(req: Request, name: string, kind: SpanKind = 'internal', attributes?: Record<string, unknown>) {
  const traceContext = getRequestTraceContext(req);
  if (traceContext) {
    return {
      traceId: traceContext.traceId,
      spanId: crypto.randomUUID(),
      parentSpanId: traceContext.spanId,
      sampled: traceContext.sampled,
    };
  }
  return undefined;
}