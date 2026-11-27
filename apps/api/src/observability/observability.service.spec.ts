import { describe, expect, it } from 'vitest';

import { ObservabilityService } from './observability.service.js';
import { classifyProviderError } from '@truevine/telephony';
import { classifyPaymentFailure } from '../payments/payment-failure-reporting.js';

function makeConfig() {
  return {
    host: 'localhost',
    port: 3001,
    environment: 'test',
    version: '0.1.0-test',
    databaseUrl: 'postgresql://stub:5432/test',
    redisUrl: 'redis://stub:6379',
    healthTimeoutMs: 50,
    serviceName: 'truevine-voice-api',
  } as never;
}

describe('ObservabilityService (API) failure counter wiring', () => {
  it('records provider failures and exposes them via collectOnce', async () => {
    const service = new ObservabilityService(makeConfig());

    service.recordProviderFailure();
    service.recordProviderFailure();

    const state = await service.collectOnce();
    expect(state.samples['provider.failures']).toBeDefined();
    expect(state.samples['provider.failures']?.value).toBe(2);

    // After snapshot, counter resets
    const state2 = await service.collectOnce();
    expect(state2.samples['provider.failures']?.value).toBe(0);
  });

  it('records payment failures and exposes them via collectOnce', async () => {
    const service = new ObservabilityService(makeConfig());

    service.recordPaymentFailure();

    const state = await service.collectOnce();
    expect(state.samples['payment.failures']).toBeDefined();
    expect(state.samples['payment.failures']?.value).toBe(1);

    // After snapshot, counter resets
    const state2 = await service.collectOnce();
    expect(state2.samples['payment.failures']?.value).toBe(0);
  });

  it('counter accumulates across multiple records before snapshot', async () => {
    const service = new ObservabilityService(makeConfig());

    service.recordProviderFailure();
    service.recordProviderFailure();
    service.recordProviderFailure();

    const state = await service.collectOnce();
    expect(state.samples['provider.failures']?.value).toBe(3);
  });

  it('provider and payment failure counters are independent', async () => {
    const service = new ObservabilityService(makeConfig());

    service.recordProviderFailure();
    service.recordPaymentFailure();
    service.recordProviderFailure();

    const state = await service.collectOnce();
    expect(state.samples['provider.failures']?.value).toBe(2);
    expect(state.samples['payment.failures']?.value).toBe(1);
  });

  it('classifies provider errors via classifyProviderError', () => {
    // Transient error: retryable, alertable
    const transient = classifyProviderError({
      statusCode: 503,
      message: 'service unavailable',
    });
    expect(transient.kind).toBe('provider_unavailable');
    expect(transient.retryable).toBe(true);

    // Auth error: not retryable, alertable
    const auth = classifyProviderError({
      statusCode: 401,
      message: 'unauthorized',
    });
    expect(auth.kind).toBe('unauthorized');
    expect(auth.retryable).toBe(false);

    // Invalid request: not retryable, not alertable
    const invalid = classifyProviderError({
      statusCode: 400,
      message: 'invalid request',
    });
    expect(invalid.kind).toBe('invalid_request');
    expect(invalid.retryable).toBe(false);

    // Unknown: not retryable, alertable
    const unknown = classifyProviderError('unexpected error');
    expect(unknown.kind).toBe('unknown');
    expect(unknown.retryable).toBe(false);
  });

  it('classifies payment failures via classifyPaymentFailure', () => {
    // Success outcomes are not classified
    expect(classifyPaymentFailure('CREDITED')).toBeUndefined();
    expect(classifyPaymentFailure('ALREADY_RECONCILED')).toBeUndefined();

    // Rejected: provider declined
    const rejected = classifyPaymentFailure('REJECTED');
    expect(rejected?.reason).toBe('provider_declined');
    expect(rejected?.retryable).toBe(false);

    // Unverified: retryable after 60s
    const unverified = classifyPaymentFailure('UNVERIFIED');
    expect(unverified?.reason).toBe('verification_failed');
    expect(unverified?.retryable).toBe(true);
    expect(unverified?.retryAfterMs).toBe(60_000);

    // Reconciliation required: retryable after 5min
    const recon = classifyPaymentFailure('RECONCILIATION_REQUIRED');
    expect(recon?.reason).toBe('reconciliation_required');
    expect(recon?.retryable).toBe(true);
    expect(recon?.retryAfterMs).toBe(300_000);

    // Unknown outcome
    const unknown = classifyPaymentFailure('UNKNOWN_OUTCOME');
    expect(unknown?.reason).toBe('unknown');
    expect(unknown?.retryable).toBe(false);
  });
});
