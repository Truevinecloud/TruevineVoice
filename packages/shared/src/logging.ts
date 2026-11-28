/**
 * Structured operational logging primitives.
 *
 * Built on top of the existing NestJS `Logger`. Adds correlation IDs and an
 * allowlist of safe log fields so that operational metadata is observable
 * without ever leaking credentials, tokens, payment secrets, sensitive audio
 * content, or unnecessary customer information.
 *
 * This package is framework-agnostic: it imports no NestJS, no HTTP framework,
 * and no provider SDK.
 */

import { randomUUID } from 'node:crypto';

/**
 * Fields that are safe to include in operational log output.
 *
 * Anything not on this list must be treated as potentially sensitive and
 * redacted or omitted before logging.
 */
export const SAFE_LOG_FIELDS = {
  correlationId: true,
  service: true,
  event: true,
  outcome: true,
  latencyMs: true,
  queueName: true,
  jobId: true,
  attemptNumber: true,
  organizationId: true,
  campaignId: true,
  recipientId: true,
  providerCallId: true,
  status: true,
  reason: true,
  policyVersion: true,
  severity: true,
} as const;

export type SafeLogField = keyof typeof SAFE_LOG_FIELDS;

/**
 * Generates a correlation ID for request tracing across service boundaries.
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Redacts an arbitrary record so only allowlisted fields survive.
 *
 * Unknown fields are dropped entirely. Values that look like secrets (tokens,
 * keys, credentials, passwords) are replaced with `[REDACTED]` even when they
 * appear under an allowlisted key name.
 */
export function redactRecord<T extends Record<string, unknown>>(record: T): Partial<T> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const field = key as SafeLogField;
    if (!SAFE_LOG_FIELDS[field]) continue;
    if (isSecretField(key) || isSecretValue(value)) {
      redacted[field] = '[REDACTED]';
      continue;
    }
    redacted[field] = value;
  }
  return redacted as Partial<T>;
}

/** Field names that always indicate a secret, regardless of the value. */
function isSecretField(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('credential') ||
    lower.includes('api_key') ||
    lower.includes('apikey') ||
    lower.includes('auth') ||
    lower.includes('session') ||
    lower.includes('connection_string') ||
    lower.includes('database_url') ||
    lower.includes('redis_url')
  );
}

/** Values that look like secrets regardless of the field name. */
function isSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  // JWT-like: three base64url segments separated by dots
  const jwtLike = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  if (jwtLike.test(value)) return true;
  // Long hex strings (32+ chars) that look like keys or hashes
  const hexLike = /^[0-9a-fA-F]{32,}$/;
  if (hexLike.test(value)) return true;
  return false;
}

/**
 * A structured log entry. The `fields` object contains only allowlisted,
 * redacted values safe for operational output.
 */
export interface LogEntry {
  readonly timestamp: string;
  readonly service: string;
  readonly correlationId: string | undefined;
  readonly level: 'log' | 'error' | 'warn' | 'debug' | 'verbose';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Builds a `LogEntry` from a message and raw fields, applying redaction.
 */
export function buildLogEntry(
  service: string,
  level: LogEntry['level'],
  message: string,
  correlationId: string | undefined,
  fields: Record<string, unknown>,
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    service,
    correlationId,
    level,
    message,
    fields: redactRecord(fields),
  };
}

/**
 * Serializes a `LogEntry` to a single-line JSON string for structured log
 * shipping. Safe for direct output to stdout/stderr.
 */
export function serializeLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/**
 * Correlation ID context carrier. Holds the current correlation ID so it can
 * be propagated through synchronous and asynchronous call chains without
 * threading it through every function signature.
 *
 * A single module-level instance is shared across the process so middleware
 * and downstream services can read and write it without DI.
 */
export class CorrelationIdContext {
  /** The process-wide singleton instance. */
  static readonly instance = new CorrelationIdContext();

  private correlationId: string | undefined;

  set(value: string | undefined): void {
    this.correlationId = value;
  }

  get(): string | undefined {
    return this.correlationId;
  }

  clear(): void {
    this.correlationId = undefined;
  }
}
