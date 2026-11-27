import { describe, expect, it } from 'vitest';

import { SyntheticSmsAdapter, syntheticResultFor } from './synthetic-sms-adapter.js';

describe('SyntheticSmsAdapter', () => {
  const adapter = new SyntheticSmsAdapter({
    environment: 'SANDBOX',
    senderId: 'SYNTHETIC',
    results: new Map(),
  });

  const baseRequest = {
    to: '+256700000000',
    body: 'Your voice call failed.',
    idempotencyKey: 'org-1:camp-1:recipient-1:attempt-1',
    organizationId: 'org-1',
    campaignId: 'camp-1',
    recipientId: 'recipient-1',
  };

  it('is ready', async () => {
    const status = await adapter.isReady();
    expect(status.provider).toBe('SYNTHETIC');
    expect(status.environment).toBe('SANDBOX');
    expect(status.configured).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.checkResult).toBe('verified');
  });

  it('accepts message by default', async () => {
    const result = await adapter.send(baseRequest);
    expect(result.accepted).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.uncertain).toBe(false);
    expect(result.providerReference).toBe('synthetic:org-1:camp-1:recipient-1:attempt-1');
  });

  it('rejects message when configured', async () => {
    const rejectingAdapter = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map([['org-1:camp-1:recipient-1:attempt-2', 'rejected']]),
    });
    const result = await rejectingAdapter.send({ ...baseRequest, idempotencyKey: 'org-1:camp-1:recipient-1:attempt-2' });
    expect(result.accepted).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.uncertain).toBe(false);
  });

  it('throws on temporary failure', async () => {
    const failingAdapter = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map([['org-1:camp-1:recipient-1:attempt-3', 'temporary_failure']]),
    });
    await expect(
      failingAdapter.send({ ...baseRequest, idempotencyKey: 'org-1:camp-1:recipient-1:attempt-3' }),
    ).rejects.toThrow('sms_provider_temporary_failure');
  });

  it('rejects on permanent failure', async () => {
    const failingAdapter = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map([['org-1:camp-1:recipient-1:attempt-4', 'permanent_failure']]),
    });
    const result = await failingAdapter.send({ ...baseRequest, idempotencyKey: 'org-1:camp-1:recipient-1:attempt-4' });
    expect(result.accepted).toBe(false);
    expect(result.rejected).toBe(true);
  });

  it('throws on timeout', async () => {
    const timeoutAdapter = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map([['org-1:camp-1:recipient-1:attempt-5', 'timeout']]),
    });
    await expect(
      timeoutAdapter.send({ ...baseRequest, idempotencyKey: 'org-1:camp-1:recipient-1:attempt-5' }),
    ).rejects.toThrow('sms_provider_timeout');
  });

  it('returns uncertain for uncertain outcome', async () => {
    const uncertainAdapter = new SyntheticSmsAdapter({
      environment: 'SANDBOX',
      senderId: 'SYNTHETIC',
      results: new Map([['org-1:camp-1:recipient-1:attempt-6', 'uncertain']]),
    });
    const result = await uncertainAdapter.send({ ...baseRequest, idempotencyKey: 'org-1:camp-1:recipient-1:attempt-6' });
    expect(result.accepted).toBe(false);
    expect(result.rejected).toBe(false);
    expect(result.uncertain).toBe(true);
  });
});

describe('syntheticResultFor', () => {
  it('produces deterministic results for the same key', () => {
    const key = 'test-key-1';
    const result1 = syntheticResultFor(key);
    const result2 = syntheticResultFor(key);
    expect(result1).toBe(result2);
  });

  it('produces different results for different keys', () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(syntheticResultFor(`key-${i}`));
    }
    // Should have some variety
    expect(results.size).toBeGreaterThan(1);
  });
});
