import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { CallbackReceipts } from '@truevine/telephony';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '../config/api.config.js';
import { LocalCallbackController } from './local-callback.controller.js';
import { LocalCallbackService } from './local-callback.service.js';
import { LOCAL_CALLBACK_KEY_HEADER } from './local-callback.shared.js';

const directories: string[] = [];

function fixture(options: { enabled?: boolean; bodyLimitBytes?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tv-local-callback-'));
  directories.push(directory);
  const token = randomBytes(32).toString('base64url');
  const keyFile = join(directory, 'key');
  writeFileSync(keyFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });

  const config = {
    host: '127.0.0.1',
    port: 3001,
    environment: 'test',
    version: '1.0.0',
    databaseUrl: 'postgresql://localhost/truevine_w402_integration_test',
    redisUrl: 'redis://localhost:56379',
    healthTimeoutMs: 2_000,
    serviceName: 'test-api',
    audioStorage: null,
    audioTtsRegion: null,
    paymentCredentialEncryptionKey: null,
    localSyntheticCallback:
      options.enabled === false
        ? null
        : { keyFile, bodyLimitBytes: options.bodyLimitBytes ?? 1_024 },
  } as ApiConfig;

  const receiveSynthetic = vi.fn(
    async (): Promise<{ accepted: boolean; reason: 'queued' | 'stale' }> => ({
      accepted: true,
      reason: 'queued',
    }),
  );
  const receipts = { receiveSynthetic } as unknown as CallbackReceipts;
  const service = new LocalCallbackService(config, receipts);
  const controller = new LocalCallbackController(service);

  const request = (
    body: unknown,
    headers: Record<string, string> = {
      'content-type': 'application/json',
      [LOCAL_CALLBACK_KEY_HEADER]: token,
    },
    remoteAddress = '127.0.0.1',
  ) => ({ headers, socket: { remoteAddress }, body });

  return { controller, service, receiveSynthetic, token, request };
}

const validBody = Buffer.from(
  JSON.stringify({
    occurredAt: '2026-11-22T00:00:00Z',
    sessionId: 'session_1',
    state: 'RINGING',
  }),
);

afterEach(() => {
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe('local-only synthetic callback ingress', () => {
  it('accepts a valid authenticated callback through the receipt boundary', async () => {
    const { controller, receiveSynthetic, request } = fixture();

    await expect(controller.synthetic(request(validBody))).resolves.toEqual({
      status: 'accepted',
      outcome: 'queued',
    });
    expect(receiveSynthetic).toHaveBeenCalledWith(
      {
        sessionId: 'session_1',
        state: 'RINGING',
        occurredAt: new Date('2026-11-22T00:00:00Z'),
      },
      { enforceChronology: true },
    );
  });

  it('rejects missing and invalid credentials before any receipt write', async () => {
    const { controller, receiveSynthetic, request } = fixture();

    await expect(
      controller.synthetic(
        request(validBody, { 'content-type': 'application/json' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.synthetic(
        request(validBody, {
          'content-type': 'application/json',
          [LOCAL_CALLBACK_KEY_HEADER]: 'not-the-credential',
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(receiveSynthetic).not.toHaveBeenCalled();
  });

  it('rejects malformed payloads and caller-supplied tenant identity before any write', async () => {
    const { controller, receiveSynthetic, request } = fixture();

    await expect(
      controller.synthetic(request(Buffer.from('{"sessionId":"session_1"}'))),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.synthetic(
        request(
          Buffer.from(
            JSON.stringify({
              occurredAt: '2026-11-22T00:00:00Z',
              sessionId: 'session_1',
              state: 'RINGING',
              organizationId: '00000000-0000-4000-8000-000000000002',
            }),
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(receiveSynthetic).not.toHaveBeenCalled();
  });

  it('rejects unsupported content types and oversized bodies before any write', async () => {
    const { controller, receiveSynthetic, request } = fixture({ bodyLimitBytes: 64 });

    await expect(
      controller.synthetic(
        request(validBody, {
          'content-type': 'text/plain',
          [LOCAL_CALLBACK_KEY_HEADER]: 'irrelevant',
        }),
      ),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    await expect(controller.synthetic(request(validBody))).rejects.toBeInstanceOf(
      PayloadTooLargeException,
    );
    expect(receiveSynthetic).not.toHaveBeenCalled();
  });

  it('reports stale chronological events with 202 and no state change', async () => {
    const { controller, receiveSynthetic, request } = fixture();
    receiveSynthetic.mockResolvedValueOnce({ accepted: false, reason: 'stale' });

    await expect(controller.synthetic(request(validBody))).resolves.toEqual({
      status: 'accepted',
      outcome: 'stale',
    });
    expect(receiveSynthetic).toHaveBeenCalledOnce();
  });

  it('keeps the route unreachable from non-loopback sources and when disabled', async () => {
    const { controller, receiveSynthetic, request } = fixture();

    await expect(controller.synthetic(request(validBody, undefined, '10.0.0.5'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(receiveSynthetic).not.toHaveBeenCalled();

    const disabled = fixture({ enabled: false });
    await expect(disabled.controller.synthetic(disabled.request(validBody))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(disabled.receiveSynthetic).not.toHaveBeenCalled();
  });

  it('maps receipt failures to a generic server error', async () => {
    const { controller, receiveSynthetic, request } = fixture();
    receiveSynthetic.mockRejectedValueOnce(new Error('database offline'));

    await expect(controller.synthetic(request(validBody))).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
