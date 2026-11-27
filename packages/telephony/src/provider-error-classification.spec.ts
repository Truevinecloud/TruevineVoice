import { describe, expect, it } from 'vitest';

import {
  classifyProviderError,
  isAlertable,
  type ProviderErrorClassification,
} from './provider-error-classification.js';

describe('provider error classification', () => {
  it('classifies HTTP 503 as provider_unavailable and retryable', () => {
    const result = classifyProviderError({ statusCode: 503 });

    expect(result.kind).toBe('provider_unavailable');
    expect(result.retryable).toBe(true);
    expect(result.summary).toContain('503');
  });

  it('classifies HTTP 429 as rate_limited with retry delay', () => {
    const result = classifyProviderError({ statusCode: 429 });

    expect(result.kind).toBe('rate_limited');
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(5_000);
    expect(result.summary).toContain('429');
  });

  it('classifies HTTP 401 as unauthorized and not retryable', () => {
    const result = classifyProviderError({ statusCode: 401 });

    expect(result.kind).toBe('unauthorized');
    expect(result.retryable).toBe(false);
    expect(result.summary).toContain('401');
  });

  it('classifies HTTP 403 as unauthorized and not retryable', () => {
    const result = classifyProviderError({ statusCode: 403 });

    expect(result.kind).toBe('unauthorized');
    expect(result.retryable).toBe(false);
  });

  it('classifies HTTP 404 as not_found and not retryable', () => {
    const result = classifyProviderError({ statusCode: 404 });

    expect(result.kind).toBe('not_found');
    expect(result.retryable).toBe(false);
  });

  it('classifies HTTP 400 as invalid_request and not retryable', () => {
    const result = classifyProviderError({ statusCode: 400 });

    expect(result.kind).toBe('invalid_request');
    expect(result.retryable).toBe(false);
  });

  it('classifies rate limit message patterns', () => {
    const result = classifyProviderError('rate limit exceeded');

    expect(result.kind).toBe('rate_limited');
    expect(result.retryable).toBe(true);
    expect(result.summary).toBe('provider rate limited');
  });

  it('classifies authentication failure message patterns', () => {
    const result = classifyProviderError('unauthorized access');

    expect(result.kind).toBe('unauthorized');
    expect(result.retryable).toBe(false);
    expect(result.summary).toBe('provider authentication failure');
  });

  it('classifies provider unavailable message patterns', () => {
    const result = classifyProviderError('service unavailable');

    expect(result.kind).toBe('provider_unavailable');
    expect(result.retryable).toBe(true);
    expect(result.summary).toBe('provider unavailable');
  });

  it('classifies not found message patterns', () => {
    const result = classifyProviderError('resource not found');

    expect(result.kind).toBe('not_found');
    expect(result.retryable).toBe(false);
    expect(result.summary).toBe('provider not found');
  });

  it('classifies invalid request message patterns', () => {
    const result = classifyProviderError('invalid request format');

    expect(result.kind).toBe('invalid_request');
    expect(result.retryable).toBe(false);
    expect(result.summary).toBe('provider invalid request');
  });

  it('classifies unknown errors as unknown and not retryable', () => {
    const result = classifyProviderError('something weird happened');

    expect(result.kind).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.summary).toBe('provider error (unclassified)');
  });

  it('classifies Error objects', () => {
    const error = new Error('rate limit exceeded');
    const result = classifyProviderError(error);

    expect(result.kind).toBe('rate_limited');
    expect(result.retryable).toBe(true);
  });

  it('classifies plain strings', () => {
    const result = classifyProviderError('service unavailable');

    expect(result.kind).toBe('provider_unavailable');
    expect(result.retryable).toBe(true);
  });

  it('HTTP status code takes precedence over message', () => {
    const result = classifyProviderError({ statusCode: 401, message: 'rate limit exceeded' });

    expect(result.kind).toBe('unauthorized');
    expect(result.retryable).toBe(false);
  });

  it('isAlertable returns true for critical kinds', () => {
    expect(isAlertable('unknown')).toBe(true);
    expect(isAlertable('provider_unavailable')).toBe(true);
    expect(isAlertable('rate_limited')).toBe(true);
    expect(isAlertable('unauthorized')).toBe(true);
  });

  it('isAlertable returns false for non-alertable kinds', () => {
    expect(isAlertable('not_found')).toBe(false);
    expect(isAlertable('invalid_request')).toBe(false);
  });

  it('returns a valid ProviderErrorClassification shape', () => {
    const result: ProviderErrorClassification = classifyProviderError('unknown error');
    expect(typeof result.kind).toBe('string');
    expect(typeof result.retryable).toBe('boolean');
    expect(typeof result.summary).toBe('string');
    if (result.retryAfterMs !== undefined) {
      expect(typeof result.retryAfterMs).toBe('number');
    }
  });
});
