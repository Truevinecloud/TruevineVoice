/**
 * HTTP translation for analytics failures.
 *
 * The body shape matches the API's existing structured errors:
 * `{ error: { code, message } }`. `code` is stable for clients; `message` is
 * human-readable. Evidence conflicts are 409 rather than 200-with-partial-data:
 * an unreconciled report must never look like accepted W5-03 evidence.
 */

import { HttpException, HttpStatus } from '@nestjs/common';

import { AnalyticsMetricsError, type AnalyticsErrorCode } from './analytics-metrics.js';

const METRICS_STATUS: Readonly<Record<AnalyticsErrorCode, HttpStatus>> = {
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  TENANT_MISMATCH: HttpStatus.FORBIDDEN,
  DUPLICATE_RECORD: HttpStatus.CONFLICT,
  ORPHAN_USAGE_EVENT: HttpStatus.CONFLICT,
  LEDGER_MISMATCH: HttpStatus.CONFLICT,
  CURRENCY_MISMATCH: HttpStatus.CONFLICT,
  UNKNOWN_CALL_STATE: HttpStatus.CONFLICT,
};

export function analyticsHttpError(
  status: HttpStatus,
  code: string,
  message: string,
): HttpException {
  return new HttpException({ error: { code, message } }, status);
}

/** Rethrows an analytics error as an HTTP error; leaves unrelated errors alone. */
export function rethrowAnalyticsError(error: unknown): never {
  if (error instanceof AnalyticsMetricsError) {
    throw analyticsHttpError(METRICS_STATUS[error.code], error.code, error.message);
  }
  throw error;
}
