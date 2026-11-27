import { describe, expect, it, vi } from 'vitest';

import { CALLBACK_SOURCES, type DurableCallbackEvent } from '@truevine/telephony';

import { AfricaTalkingCallbackController } from './africa-talking-callback.controller.js';

const controller = (apiKey: string | null) => {
  const receive = vi.fn<(event: DurableCallbackEvent) => Promise<void>>().mockResolvedValue(undefined);
  return {
    receive,
    handler: new AfricaTalkingCallbackController(
      { receive } as unknown as ConstructorParameters<typeof AfricaTalkingCallbackController>[0],
      apiKey,
    ),
  };
};

const request = (body: unknown, apiKey?: string) => ({
  headers: apiKey ? { apikey: apiKey } : {},
  body,
});

const completed = {
  sessionId: 'ATVId_abc',
  callSessionState: 'Completed',
  isActive: '0',
};

describe('AfricaTalkingCallbackController — fail-closed strict receipt intake', () => {
  it('rejects every callback when no key is configured', async () => {
    const { handler, receive } = controller(null);
    await expect(handler.receive(request(completed, 'any'))).rejects.toMatchObject({ status: 503 });
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong key', async () => {
    const { handler, receive } = controller('expected');
    await expect(handler.receive(request(completed))).rejects.toMatchObject({ status: 401 });
    await expect(handler.receive(request(completed, 'wrong'))).rejects.toMatchObject({ status: 401 });
    expect(receive).not.toHaveBeenCalled();
  });

  it('normalizes an authenticated provider event into a durable receipt', async () => {
    const { handler, receive } = controller('expected');
    const result = await handler.receive(request(completed, 'expected'));
    expect(result).toEqual({ received: true });
    expect(receive).toHaveBeenCalledOnce();
    expect(receive.mock.calls[0]?.[0]).toMatchObject({
      source: CALLBACK_SOURCES.africasTalking,
      sessionId: 'ATVId_abc',
      state: 'COMPLETED',
    });
    const event = receive.mock.calls[0]?.[0];
    expect(event?.eventKey).toMatch(/^[a-f0-9]{64}$/);
    expect(event?.receivedAt).toBeInstanceOf(Date);
    expect(event?.occurredAt).toBeInstanceOf(Date);
    expect(event?.occurredAt).toEqual(event?.receivedAt);
  });

  it('rejects a malformed session id or unknown state instead of mapping to DIALING', async () => {
    const { handler, receive } = controller('expected');
    await expect(
      handler.receive(request({ ...completed, sessionId: 'bad id with spaces' }, 'expected')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      handler.receive(request({ ...completed, callSessionState: 'unrecognised' }, 'expected')),
    ).rejects.toMatchObject({ status: 400 });
    expect(receive).not.toHaveBeenCalled();
  });

  it('rejects unsupported and undocumented provider fields', async () => {
    const { handler, receive } = controller('expected');
    await expect(
      handler.receive(request({ ...completed, status: 'Completed' }, 'expected')),
    ).rejects.toMatchObject({ status: 400 });
    await expect(handler.receive(request([completed], 'expected'))).rejects.toMatchObject({
      status: 400,
    });
    expect(receive).not.toHaveBeenCalled();
  });

  it('produces a stable dedupe key for an exact provider retry and a new key for a new state', async () => {
    const first = controller('expected');
    const second = controller('expected');
    const third = controller('expected');

    const ringing = {
      sessionId: 'ATVId_abc',
      callSessionState: 'Ringing',
      isActive: '1',
    };

    await first.handler.receive(request(ringing, 'expected'));
    await second.handler.receive(request(ringing, 'expected'));
    await third.handler.receive(request(completed, 'expected'));

    expect(second.receive.mock.calls[0]?.[0].eventKey).toBe(first.receive.mock.calls[0]?.[0].eventKey);
    expect(third.receive.mock.calls[0]?.[0].eventKey).not.toBe(first.receive.mock.calls[0]?.[0].eventKey);
  });
});
