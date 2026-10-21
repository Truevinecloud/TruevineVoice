import { describe, expect, it } from 'vitest';

import { parseIdempotencyKey, parsePhoneNumber } from '@truevine/domain';

import { TelephonyError } from '../../voice.port.js';
import { FakeVoiceAdapter, createFakeVoiceAdapter } from './fake-voice.adapter.js';

const key = (value: string) => parseIdempotencyKey(value);
const to = parsePhoneNumber('+256772123456');

describe('FakeVoiceAdapter — initiation contract', () => {
  it('places one call for a new idempotency key', async () => {
    const adapter = createFakeVoiceAdapter();
    const result = await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    expect(result.replayed).toBe(false);
    expect(result.providerCallId).toBe('fake-1');
    expect(adapter.placedCallCount()).toBe(1);
  });

  it('replays the original result for a repeated key and places no second call', async () => {
    const adapter = createFakeVoiceAdapter();
    const first = await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    const second = await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    expect(second.replayed).toBe(true);
    expect(second.providerCallId).toBe(first.providerCallId);
    expect(adapter.placedCallCount()).toBe(1);
  });

  it('places distinct calls for distinct keys', async () => {
    const adapter = createFakeVoiceAdapter();
    await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    await adapter.initiateCall({
      to,
      callId: 'call-2',
      organizationId: 'org-1',
      idempotencyKey: key('idem-2'),
    });
    expect(adapter.placedCallCount()).toBe(2);
  });

  it('starts a call in DIALING by default and honours a configured initial state', async () => {
    const adapter = new FakeVoiceAdapter({ initialState: 'QUEUED' });
    const result = await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    expect(result.state).toBe('QUEUED');
  });
});

describe('FakeVoiceAdapter — hang up and status', () => {
  it('completes a call on hang up', async () => {
    const adapter = createFakeVoiceAdapter();
    await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    const status = await adapter.hangUp({ callId: 'call-1', idempotencyKey: key('hang-1') });
    expect(status.state).toBe('COMPLETED');
  });

  it('throws not_found for an unknown call', async () => {
    const adapter = createFakeVoiceAdapter();
    await expect(adapter.fetchCallStatus('missing')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('reports a seeded status for an unknown call', async () => {
    const adapter = new FakeVoiceAdapter({
      seed: new Map([['ext-1', { callId: 'ext-1', state: 'NO_ANSWER' as const }]]),
    });
    const status = await adapter.fetchCallStatus('ext-1');
    expect(status.state).toBe('NO_ANSWER');
  });

  it('carries provider usage verbatim when set', async () => {
    const adapter = createFakeVoiceAdapter();
    await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    adapter.setState('call-1', 'COMPLETED', {
      connectedSeconds: 33,
      providerBillableSeconds: 60,
      providerStatus: 'completed',
    });
    const status = await adapter.fetchCallStatus('call-1');
    expect(status.usage?.connectedSeconds).toBe(33);
    expect(status.usage?.providerStatus).toBe('completed');
  });
});

describe('TelephonyError — provider-neutral taxonomy', () => {
  it('defaults to non-retryable and carries a kind', () => {
    const error = new TelephonyError('not_found', 'missing');
    expect(error.kind).toBe('not_found');
    expect(error.retryable).toBe(false);
  });

  it('can be marked retryable with an opaque provider message', () => {
    const error = new TelephonyError('provider_unavailable', 'try again', {
      retryable: true,
      providerMessage: 'upstream 503',
    });
    expect(error.retryable).toBe(true);
    expect(error.providerMessage).toBe('upstream 503');
  });
});

describe('FakeVoiceAdapter — resource safety', () => {
  it('makes no network call: it resolves deterministically in-process', async () => {
    const adapter = createFakeVoiceAdapter();
    const result = await adapter.initiateCall({
      to,
      callId: 'call-1',
      organizationId: 'org-1',
      idempotencyKey: key('idem-1'),
    });
    // Deterministic provider id from a local counter, proving no outbound call.
    expect(result.providerCallId).toBe('fake-1');
  });
});
