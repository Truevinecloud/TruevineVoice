/**
 * Provider error classification for voice telephony.
 *
 * Maps raw provider error messages and HTTP status codes to the
 * provider-neutral `TelephonyErrorKind` taxonomy. This module does NOT
 * implement any provider adapter: it only classifies errors after an adapter
 * has already translated them into our vocabulary.
 *
 * Classification is conservative: unknown errors map to 'unknown' with
 * `retryable: false`, so failures fail closed rather than being retried
 * blindly.
 */

import type { TelephonyErrorKind } from './voice.port.js';

/**
 * Classification result for a provider error.
 */
export interface ProviderErrorClassification {
  readonly kind: TelephonyErrorKind;
  /** Whether the same idempotency key may be reused on retry. */
  readonly retryable: boolean;
  /** Suggested retry delay in milliseconds, or undefined when no retry. */
  readonly retryAfterMs: number | undefined;
  /** Human-readable summary, safe for logging. */
  readonly summary: string;
}

/** HTTP status codes that indicate transient provider overload. */
const TRANSIENT_STATUS_CODES = new Set([408, 500, 502, 503, 504]);

/** Error message substrings that indicate rate limiting. */
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /throttl/i,
  /quota/i,
];

/** Error message substrings that indicate authentication failure. */
const AUTH_PATTERNS = [
  /unauthorized/i,
  /authentication/i,
  /invalid.?api.?key/i,
  /invalid.?credentials/i,
  /401/i,
  /403/i,
];

/** Error message substrings that indicate provider unavailability. */
const PROVIDER_UNAVAILABLE_PATTERNS = [
  /unavailable/i,
  /service.?unavailable/i,
  /maintenance/i,
  /downtime/i,
  /503/i,
];

/** Error message substrings that indicate a not-found error. */
const NOT_FOUND_PATTERNS = [/not.?found/i, /404/i, /no.?such/i];

/** Error message substrings that indicate an invalid request. */
const INVALID_REQUEST_PATTERNS = [
  /invalid.?request/i,
  /bad.?request/i,
  /malformed/i,
  /400/i,
  /validation.?error/i,
];

/**
 * Classifies a provider error from an HTTP status code and/or error message.
 *
 * Falls through from most specific to least specific: if no pattern matches,
 * the error is classified as 'unknown' and non-retryable.
 */
export function classifyProviderError(
  input: { readonly statusCode?: number; readonly message?: string } | Error | string,
): ProviderErrorClassification {
  const statusCode =
    typeof input === 'object' && input !== null && 'statusCode' in input
      ? (input as { readonly statusCode?: number }).statusCode
      : undefined;
  const message =
    typeof input === 'object' && input !== null && 'message' in input
      ? (input as { readonly message?: string }).message
      : typeof input === 'string'
        ? input
        : input instanceof Error
          ? input.message
          : undefined;

  // HTTP status code takes precedence when it maps cleanly.
  if (statusCode !== undefined) {
    if (statusCode === 429) {
      return {
        kind: 'rate_limited',
        retryable: true,
        retryAfterMs: 5_000,
        summary: 'provider HTTP 429 (rate limited)',
      };
    }
    if (TRANSIENT_STATUS_CODES.has(statusCode)) {
      return {
        kind: 'provider_unavailable',
        retryable: true,
        retryAfterMs: statusCode === 429 ? 5_000 : undefined,
        summary: `provider HTTP ${statusCode} (transient)`,
      };
    }
    if (statusCode === 401 || statusCode === 403) {
      return {
        kind: 'unauthorized',
        retryable: false,
        retryAfterMs: undefined,
        summary: `provider HTTP ${statusCode} (unauthorized)`,
      };
    }
    if (statusCode === 404) {
      return {
        kind: 'not_found',
        retryable: false,
        retryAfterMs: undefined,
        summary: `provider HTTP ${statusCode} (not found)`,
      };
    }
    if (statusCode === 400) {
      return {
        kind: 'invalid_request',
        retryable: false,
        retryAfterMs: undefined,
        summary: `provider HTTP ${statusCode} (invalid request)`,
      };
    }
  }

  const msg = message ?? '';

  for (const pattern of AUTH_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        kind: 'unauthorized',
        retryable: false,
        retryAfterMs: undefined,
        summary: 'provider authentication failure',
      };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        kind: 'rate_limited',
        retryable: true,
        retryAfterMs: 5_000,
        summary: 'provider rate limited',
      };
    }
  }

  for (const pattern of PROVIDER_UNAVAILABLE_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        kind: 'provider_unavailable',
        retryable: true,
        retryAfterMs: 10_000,
        summary: 'provider unavailable',
      };
    }
  }

  for (const pattern of NOT_FOUND_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        kind: 'not_found',
        retryable: false,
        retryAfterMs: undefined,
        summary: 'provider not found',
      };
    }
  }

  for (const pattern of INVALID_REQUEST_PATTERNS) {
    if (pattern.test(msg)) {
      return {
        kind: 'invalid_request',
        retryable: false,
        retryAfterMs: undefined,
        summary: 'provider invalid request',
      };
    }
  }

  return {
    kind: 'unknown',
    retryable: false,
    retryAfterMs: undefined,
    summary: 'provider error (unclassified)',
  };
}

/**
 * Determines whether a TelephonyErrorKind should trigger an alert.
 *
 * Permanent failures (invalid_request, unauthorized, not_found) are alerted
 * once. Transient failures (rate_limited, provider_unavailable) are alerted
 * when they exceed a threshold. Unknown failures are always alerted.
 */
export function isAlertable(kind: TelephonyErrorKind): boolean {
  return kind !== 'not_found' && kind !== 'invalid_request';
}
