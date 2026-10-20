import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config/env.js';
import { isDomainError, ValidationError } from '@/types/errors.js';
import type { DomainError } from '@/types/errors.js';
import { isPaymentError } from '@/types/payment-errors.js';
import type { PaymentError } from '@/types/payment-errors.js';
import { structuredLog, type RequestWithId } from './logging.middleware.js';
import { incCounter, httpErrorsTotal } from './metrics.middleware.js';

// ── Body-parser error types ───────────────────────────────────────────────────
// express.json() throws a plain SyntaxError for malformed JSON and a custom
// error with status 413 for payloads that exceed the configured limit.

interface BodyParserError extends SyntaxError {
  status?: number;
  body?: unknown;
  type?: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

interface PaymentErrorResponse {
  error: {
    code: string;
    category: string;
    message: string;
    retryable: boolean;
    allowedActions: string[];
    status: string;
    idempotencyKey?: string;
    requestId?: string;
  };
}

interface ValidationErrorResponse {
  message: string;
  fields: Record<string, string[]>;
  requestId?: string;
}

const ERROR_STATUS_MAP: Record<string, number> = {
  // Auth errors
  INVALID_CREDENTIALS: 401,
  USER_NOT_FOUND: 404,
  USER_ALREADY_EXISTS: 409,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  UNAUTHORIZED: 403,

  // Booking errors
  PROPERTY_NOT_FOUND: 404,
  BOOKING_OVERLAP: 409,
  ESCROW_FAILED: 400,
  INVALID_DATES: 400,
  INSUFFICIENT_FUNDS: 402,
  BOOKING_NOT_FOUND: 404,
  INVALID_STATUS: 400,

  // Escrow errors
  ESCROW_CREATION_FAILED: 400,
  ESCROW_RELEASE_FAILED: 400,
  ESCROW_NOT_FOUND: 404,
  INVALID_ESCROW_STATE: 400,
  INSUFFICIENT_ESCROW_BALANCE: 402,

  // Property errors
  UNAUTHORIZED_OWNER: 403,
  INVALID_PROPERTY_DATA: 400,

  // Validation errors
  VALIDATION_ERROR: 400,
  MISSING_REQUIRED_FIELD: 400,
  INVALID_DATE_FORMAT: 400,

  // Rate limit errors
  RATE_LIMITED: 429,

  // Infrastructure / timeout
  REQUEST_TIMEOUT: 504,
  INTERNAL_SERVER_ERROR: 500,
};

// ── Internal helper ───────────────────────────────────────────────────────────

/**
 * Emit a structured error log entry and increment the HTTP error counter.
 * The request-ID from the incoming request is always included so the log
 * entry can be correlated with the originating request in any log viewer.
 */
function logAndCount(
  req: Request,
  statusCode: number,
  code: string,
  err: Error,
): void {
  const typedReq = req as RequestWithId;

  structuredLog({
    level: statusCode >= 500 ? 'error' : 'warn',
    message: `Request error: ${code}`,
    timestamp: new Date().toISOString(),
    requestId: typedReq.requestId,
    userId: typedReq.userId,
    method: req.method,
    path: req.path,
    status: statusCode,
    errorCode: code,
    errorMessage: err.message,
    // Only include stack traces for 5xx — never expose them in 4xx logs
    ...(statusCode >= 500 && { stack: err.stack }),
  });

  const statusClass = statusCode >= 500 ? '5xx' : '4xx';
  incCounter(httpErrorsTotal, {
    method: req.method,
    route: req.path,
    status_class: statusClass,
  });
}

// ── Error middleware ──────────────────────────────────────────────────────────

export function errorMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = (req as RequestWithId).requestId;

  // ── Multer / Image Upload errors ─────────────────────────────────────────
  if (err.name === 'MulterError') {
    logAndCount(req, 400, 'FILE_UPLOAD_ERROR', err);
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: `File size exceeds maximum allowed size of ${env.MAX_IMAGE_SIZE_BYTES} bytes` });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message === 'Only JPEG, PNG, and WebP images are allowed') {
    logAndCount(req, 400, 'INVALID_FILE_TYPE', err);
    res.status(400).json({ error: err.message });
    return;
  }

  // ── 413 Payload Too Large ─────────────────────────────────────────────────
  const bodyParserErr = err as BodyParserError;
  if (bodyParserErr.status === 413 || bodyParserErr.type === 'entity.too.large') {
    logAndCount(req, 413, 'PAYLOAD_TOO_LARGE', err);
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the maximum allowed size.',
        requestId,
      },
    } satisfies ErrorResponse);
    return;
  }

  // ── 400 Malformed JSON ────────────────────────────────────────────────────
  if (
    err instanceof SyntaxError &&
    (bodyParserErr.status === 400 || bodyParserErr.type === 'entity.parse.failed')
  ) {
    logAndCount(req, 400, 'MALFORMED_JSON', err);
    res.status(400).json({
      error: {
        code: 'MALFORMED_JSON',
        message: 'Request body contains invalid JSON.',
        requestId,
      },
    } satisfies ErrorResponse);
    return;
  }

  // ── Validation errors ─────────────────────────────────────────────────────
  if (err instanceof ValidationError) {
    logAndCount(req, 400, 'VALIDATION_ERROR', err);
    const response: ValidationErrorResponse = {
      message: err.message,
      fields: err.fields,
      requestId,
    };
    res.status(400).json(response);
    return;
  }

  // ── Payment errors ────────────────────────────────────────────────────────
  // Payment failures carry a shared taxonomy (category, safe user message,
  // allowed next actions, transaction status). Serialize only the safe,
  // user-facing fields; full internal details are logged server-side only.
  if (isPaymentError(err)) {
    const paymentErr = err as PaymentError;
    const statusCode = paymentErr.httpStatus;
    logAndCount(req, statusCode, paymentErr.code, err);

    // Log the full internal context (category, status, idempotency key,
    // underlying cause) server-side only — never returned to the client.
    structuredLog({
      level: statusCode >= 500 ? 'error' : 'warn',
      message: `Payment error: ${paymentErr.code}`,
      timestamp: new Date().toISOString(),
      requestId,
      method: req.method,
      path: req.path,
      status: statusCode,
      errorCode: paymentErr.code,
      paymentCategory: paymentErr.category,
      paymentStatus: paymentErr.status,
      retryable: paymentErr.retryable,
      allowedActions: paymentErr.allowedActions,
      idempotencyKey: paymentErr.idempotencyKey,
      ...(paymentErr.cause instanceof Error && { cause: paymentErr.cause.message }),
    });

    const response: PaymentErrorResponse = {
      error: {
        code: paymentErr.code,
        category: paymentErr.category,
        message: paymentErr.userMessage,
        retryable: paymentErr.retryable,
        allowedActions: paymentErr.allowedActions,
        status: paymentErr.status,
        requestId,
      },
    };
    if (paymentErr.idempotencyKey) {
      response.error.idempotencyKey = paymentErr.idempotencyKey;
    }
    res.status(statusCode).json(response);
    return;
  }

  // ── Domain errors ─────────────────────────────────────────────────────────
  if (isDomainError(err)) {
    const domainErr = err as DomainError;
    const statusCode = ERROR_STATUS_MAP[domainErr.code] ?? 400;
    logAndCount(req, statusCode, domainErr.code, err);

    const response: ErrorResponse = {
      error: {
        code: domainErr.code,
        message: domainErr.message,
        requestId,
      },
    };
    if (domainErr.details) {
      response.error.details = domainErr.details;
    }
    res.status(statusCode).json(response);
    return;
  }

  // ── Untyped / unexpected errors ───────────────────────────────────────────
  logAndCount(req, 500, 'INTERNAL_SERVER_ERROR', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      // Never expose raw err.message for untyped errors in production
      message: 'Internal server error',
      requestId,
    },
  } satisfies ErrorResponse);
}
