/**
 * Express middleware for correlation ID propagation.
 *
 * Extracts or generates a correlation ID for each incoming request and makes
 * it available through the shared `CorrelationIdContext` so downstream code can
 * include it in log entries. The correlation ID is also echoed in the
 * `X-Correlation-Id` response header for client-side tracing.
 *
 * Never logs request bodies, headers, or query parameters that may contain
 * credentials, tokens, payment secrets, or customer information.
 */

import { type RequestHandler } from 'express';

import { CorrelationIdContext, generateCorrelationId } from '@truevine/shared';

/**
 * Header name used to propagate correlation IDs across service boundaries.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Creates an Express middleware that assigns a correlation ID to each request.
 *
 * The context is a module-level singleton shared by the logging module; any
 * code that calls `buildLogEntry` during request handling will automatically
 * include the current correlation ID.
 */
export function correlationIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof incoming === 'string' && incoming.length > 0
        ? incoming
        : generateCorrelationId();

    CorrelationIdContext.instance.set(correlationId);
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    // Clear the context after the response finishes so the ID does not leak
    // into the next request handled by the same process.
    res.on('finish', () => {
      CorrelationIdContext.instance.clear();
    });

    next();
  };
}
