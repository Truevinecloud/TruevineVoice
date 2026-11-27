import { describe, expect, it } from 'vitest';

import {
  SAFE_LOG_FIELDS,
  buildLogEntry,
  generateCorrelationId,
  serializeLogEntry,
  type LogEntry,
} from './logging.js';

describe('structured logging', () => {
  it('generates a valid UUID correlation ID', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(generateCorrelationId()).not.toBe(id);
  });

  it('builds a log entry with only allowlisted fields', () => {
    const entry = buildLogEntry(
      'test-service',
      'log',
      'test message',
      'corr-123',
      { correlationId: 'corr-123', secret: 'should-be-redacted', queueName: 'test-queue' },
    );

    expect(entry.service).toBe('test-service');
    expect(entry.level).toBe('log');
    expect(entry.message).toBe('test message');
    expect(entry.correlationId).toBe('corr-123');
    expect(entry.fields.secret).toBeUndefined();
    expect(entry.fields.queueName).toBe('test-queue');
  });

  it('drops fields that are not on the safe allowlist', () => {
    const entry = buildLogEntry(
      'test-service',
      'error',
      'failed',
      undefined,
      { api_key: 'sk-live-abc123', password: 'hunter2', token: 'Bearer xxx', queueName: 'ok' },
    );

    expect(entry.fields.api_key).toBeUndefined();
    expect(entry.fields.password).toBeUndefined();
    expect(entry.fields.token).toBeUndefined();
    expect(entry.fields.queueName).toBe('ok');
  });

  it('redacts JWT-like values even under safe field names', () => {
    const entry = buildLogEntry(
      'test-service',
      'log',
      'test',
      undefined,
      { correlationId: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy', queueName: 'ok' },
    );

    expect(entry.fields.correlationId).toBe('[REDACTED]');
    expect(entry.fields.queueName).toBe('ok');
  });

  it('redacts long hex values even under safe field names', () => {
    const entry = buildLogEntry(
      'test-service',
      'log',
      'test',
      undefined,
      { correlationId: 'a'.repeat(40), queueName: 'ok' },
    );

    expect(entry.fields.correlationId).toBe('[REDACTED]');
    expect(entry.fields.queueName).toBe('ok');
  });

  it('serializes to single-line JSON', () => {
    const entry: LogEntry = {
      timestamp: '2026-01-01T00:00:00.000Z',
      service: 'test-service',
      correlationId: 'corr-123',
      level: 'log',
      message: 'hello',
      fields: { queueName: 'test-queue' },
    };

    const serialized = serializeLogEntry(entry);
    const parsed = JSON.parse(serialized);
    expect(parsed.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.service).toBe('test-service');
    expect(parsed.correlationId).toBe('corr-123');
    expect(parsed.message).toBe('hello');
    expect(parsed.fields.queueName).toBe('test-queue');
    expect(serialized.includes('\n')).toBe(false);
  });

  it('includes no secrets in serialized output', () => {
    const entry = buildLogEntry(
      'test-service',
      'error',
      'failed',
      undefined,
      { databaseUrl: 'postgresql://user:pass@host/db', queueName: 'ok' },
    );

    const serialized = serializeLogEntry(entry);
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('user:pass');
    expect(serialized).toContain('"queueName":"ok"');
  });

  it('defines a safe log fields allowlist', () => {
    const fields = SAFE_LOG_FIELDS as Record<string, unknown>;
    expect(SAFE_LOG_FIELDS.correlationId).toBe(true);
    expect(SAFE_LOG_FIELDS.queueName).toBe(true);
    expect(fields['secret']).toBeUndefined();
    expect(fields['password']).toBeUndefined();
  });
});
