import { describe, expect, it, vi } from 'vitest';

import { parseIdempotencyKey, parsePhoneNumber } from '@truevine/domain';

import { TelephonyError } from '../../voice.port.js';
import {
  createAfricaTalkingVoiceAdapter,
  mapAfricaTalkingStatus,
  type AfricaTalkingVoiceAdapterOptions,
} from './africa-talking-voice.adapter.js';

const destination = parsePhoneNumber('+256766207549');
const key = parseIdempotencyKey('live-test-1');
const apiKey = 'test-key-not-a-secret';

function options(overrides: Partial<AfricaTalkingVoiceAdapterOptions> = {}) {
  return {
    username: 'sandbox',
    apiKey,
    voiceNumber: '+256700000001',
    environment: 'SANDBOX' as const,
    fetch: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const request = {
  to: destination,
  callId: 'call-1',
  organizationId: 'org-1',
  idempotencyKey: key,
};

describe('AfricaTalkingVoiceAdapter — official call contract', () => {
  it('posts to the sandbox voice host with username, from, to and clientRequestId', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ entries: [{ phoneNumber: destination, status: 'Queued', sessionId: 'ATVId_abc' }] }),
    );
    const adapter = createAfricaTalkingVoiceAdapter(options({ fetch }));

    const result = await adapter.initiateCall(request);

    expect(result).toEqual({
      callId: 'call-1',
      state: 'QUEUED',
      providerCallId: 'ATVId_abc',
      replayed: false,
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://voice.sandbox.africastalking.com/call');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).apikey).toBe(apiKey);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('username')).toBe('sandbox');
    expect(body.get('from')).toBe('+256700000001');
    expect(body.get('to')).toBe('+256766207549');
    expect(body.get('clientRequestId')).toBe('live-test-1');
  });

  it('plays one prerecorded HTTPS file through callActions without a callback URL', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ entries: [{ status: 'Queued', sessionId: 'ATVId_play' }] }),
    );
    const adapter = createAfricaTalkingVoiceAdapter(options({ fetch }));

    await adapter.initiateCall({
      ...request,
      audioRef: 'https://example.invalid/short-greeting.mp3',
    });

    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      username: 'sandbox',
      from: '+256700000001',
      to: ['+256766207549'],
      clientRequestId: 'live-test-1',
      callActions: [{ actionType: 'Play', url: 'https://example.invalid/short-greeting.mp3' }],
    });
  });

  it('rejects a non-HTTPS audio reference before any request', async () => {
    const fetch = vi.fn();
    const adapter = createAfricaTalkingVoiceAdapter(options({ fetch }));
    await expect(
      adapter.initiateCall({ ...request, audioRef: 'http://example.invalid/a.mp3' }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the live voice host in PRODUCTION mode', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ entries: [{ status: 'Queued', sessionId: 'ATVId_live' }] }, 201),
    );
    const adapter = createAfricaTalkingVoiceAdapter(options({ environment: 'PRODUCTION', fetch }));

    await adapter.initiateCall(request);

    expect((fetch.mock.calls[0] as [string])[0]).toBe('https://voice.africastalking.com/call');
  });

  it('accepts both HTTP 200 and 201 and maps queued state', () => {
    expect(mapAfricaTalkingStatus('Queued')).toBe('QUEUED');
    expect(mapAfricaTalkingStatus('Ringing')).toBe('RINGING');
    expect(mapAfricaTalkingStatus('Answered')).toBe('ANSWERED');
    expect(mapAfricaTalkingStatus('Completed')).toBe('COMPLETED');
    expect(mapAfricaTalkingStatus(undefined)).toBe('DIALING');
  });

  it('rejects an invalid destination, caller id or environment before any request', async () => {
    const fetch = vi.fn();
    const adapter = createAfricaTalkingVoiceAdapter(options({ fetch }));
    await expect(adapter.initiateCall({ ...request, to: '0776123456' as never })).rejects.toMatchObject({
      kind: 'invalid_request',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => createAfricaTalkingVoiceAdapter(options({ voiceNumber: '700000001' }))).toThrow(TelephonyError);
    expect(() => createAfricaTalkingVoiceAdapter(options({ environment: 'TEST' as never }))).toThrow(TelephonyError);
  });

  it('maps provider HTTP failures without retrying client errors', async () => {
    const cases: Array<[number, TelephonyError['kind'], boolean]> = [
      [401, 'unauthorized', false],
      [403, 'unauthorized', false],
      [429, 'rate_limited', true],
      [500, 'provider_unavailable', true],
      [202, 'invalid_request', false],
    ];
    for (const [status, kind, retryable] of cases) {
      const fetch = vi.fn().mockResolvedValue(new Response('nope', { status }));
      const adapter = createAfricaTalkingVoiceAdapter(options({ fetch }));
      await expect(adapter.initiateCall(request)).rejects.toMatchObject({ kind, retryable });
    }
  });

  it('treats timeouts and network failures as uncertain and retryable', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const fetch = vi.fn().mockRejectedValue(timeout);
    const adapter = createAfricaTalkingVoiceAdapter(options({ fetch, timeoutMs: 5 }));
    await expect(adapter.initiateCall(request)).rejects.toMatchObject({
      kind: 'provider_unavailable',
      retryable: true,
    });
  });

  it('rejects whole-request errors and non-queued entry statuses', async () => {
    const whole = createAfricaTalkingVoiceAdapter(
      options({ fetch: vi.fn().mockResolvedValue(jsonResponse({ errorMessage: 'Bad request' })) }),
    );
    await expect(whole.initiateCall(request)).rejects.toMatchObject({ kind: 'provider_unavailable' });

    for (const status of ['InvalidPhoneNumber', 'DestinationNotSupported', 'InsufficientCredit']) {
      const adapter = createAfricaTalkingVoiceAdapter(
        options({ fetch: vi.fn().mockResolvedValue(jsonResponse({ entries: [{ status }] })) }),
      );
      await expect(adapter.initiateCall(request)).rejects.toMatchObject({
        kind: 'invalid_request',
        retryable: false,
      });
    }
  });

  it('does not invent a session id when the provider omits one', async () => {
    const adapter = createAfricaTalkingVoiceAdapter(
      options({ fetch: vi.fn().mockResolvedValue(jsonResponse({ entries: [{ status: 'Queued', sessionId: 'None' }] })) }),
    );
    await expect(adapter.initiateCall(request)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not leak the API key in error messages', async () => {
    const adapter = createAfricaTalkingVoiceAdapter(
      options({ fetch: vi.fn().mockResolvedValue(new Response('denied', { status: 401 })) }),
    );
    try {
      await adapter.initiateCall(request);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TelephonyError);
      expect((error as Error).message).not.toContain(apiKey);
    }
  });

  it('never claims to support call status polling or provider hang-up', async () => {
    const adapter = createAfricaTalkingVoiceAdapter(options());
    await expect(adapter.fetchCallStatus('call-1')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(
      adapter.hangUp({ callId: 'call-1', idempotencyKey: key }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});
