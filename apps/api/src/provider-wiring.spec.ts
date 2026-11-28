import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CALLBACK_SOURCES, CallbackReceipts } from '@truevine/telephony';
import { describe, expect, it, vi } from 'vitest';

import { AppModule } from './app.module.js';
import { AfricaTalkingCallbackController, callbackApiKeyFromEnv } from './africas-talking-callback/africa-talking-callback.controller.js';
import { AfricaTalkingCallbackModule } from './africas-talking-callback/africa-talking-callback.module.js';
import { CsrfGuard } from './auth/csrf.guard.js';
import { OrganizationGuard, PlatformGuard } from './auth/organization.guard.js';
import {
  ORGANIZATION_PERMISSION,
  PLATFORM_PERMISSION,
} from './auth/permission.decorators.js';
import { SessionGuard } from './auth/session.guard.js';
import { ObservabilityController } from './observability/observability.controller.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { SmsFallbackController } from './sms/sms-fallback.controller.js';
import {
  SmsFallbackModule,
  smsPortFromEnvironment,
} from './sms/sms-fallback.module.js';
import { DATABASE_CLIENT } from './tokens.js';
import { VoiceProvidersController } from './voice-providers/voice-providers.module.js';
import { VoiceProvidersModule } from './voice-providers/voice-providers.module.js';
import {
  VoiceProvidersService,
  voiceKeyFromEnv,
} from './voice-providers/voice-providers.service.js';

function guardsOf(target: object): readonly unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as readonly unknown[];
}

describe('fail-closed API provider wiring', () => {
  it('registers only the approved API-side commercial modules', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as readonly unknown[];

    expect(imports).toEqual(
      expect.arrayContaining([
        VoiceProvidersModule,
        AfricaTalkingCallbackModule,
        SmsFallbackModule,
        ObservabilityModule,
      ]),
    );
  });

  it('keeps voice provider writes behind platform-owner authorization', () => {
    for (const name of ['list', 'save', 'check', 'activate'] as const) {
      const route = VoiceProvidersController.prototype[name];
      expect(guardsOf(route), name).toEqual(
        expect.arrayContaining([SessionGuard, PlatformGuard]),
      );
      expect(Reflect.getMetadata(PLATFORM_PERMISSION, route), name).toBe(
        'platform:technical:write',
      );
    }
    for (const name of ['save', 'check', 'activate'] as const) {
      expect(guardsOf(VoiceProvidersController.prototype[name]), name).toContain(CsrfGuard);
    }
  });

  it('keeps SMS fallback behind session, organization scope, terms and CSRF', () => {
    const route = SmsFallbackController.prototype.triggerFallback;
    expect(guardsOf(route)).toEqual(
      expect.arrayContaining([SessionGuard, OrganizationGuard, CsrfGuard]),
    );
    expect(Reflect.getMetadata(ORGANIZATION_PERMISSION, route)).toBe('campaign:update');
  });

  it('keeps metrics read-only behind platform operations authorization', () => {
    expect(guardsOf(ObservabilityController)).toEqual(
      expect.arrayContaining([SessionGuard, PlatformGuard]),
    );
    expect(Reflect.getMetadata(PLATFORM_PERMISSION, ObservabilityController)).toBe(
      'platform:operations:read',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, ObservabilityController.prototype.getMetrics)).toBe(
      RequestMethod.GET,
    );
  });

  it('mounts the callback as an authenticated receipt-only POST', () => {
    const route = AfricaTalkingCallbackController.prototype.receive;
    expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA, route)).toBe('/');
  });

  it('treats missing or weak callback and voice keys as unavailable', () => {
    expect(callbackApiKeyFromEnv(undefined)).toBeNull();
    expect(callbackApiKeyFromEnv('   ')).toBeNull();
    expect(callbackApiKeyFromEnv('short-key')).toBeNull();

    const candidate = `x${'y'.repeat(31)}`;
    expect(callbackApiKeyFromEnv(` ${candidate} `)).toBe(candidate);
    expect(voiceKeyFromEnv(undefined)).toBeNull();
    expect(voiceKeyFromEnv('not-a-key')).toBeNull();
    expect(voiceKeyFromEnv(Buffer.alloc(32, 1).toString('base64'))).toBeInstanceOf(Buffer);
  });

  it('refuses voice credential use and makes no outbound request without a key', async () => {
    const row = {
      environment: 'SANDBOX',
      username: 'sandbox',
      voiceNumber: '',
      ciphertext: 'opaque-ciphertext',
      enabled: false,
      checkedAt: null,
      checkResult: null,
      version: 1,
    };
    const db = { $queryRaw: vi.fn(async () => [row]) };
    const fetchMock = vi.fn<typeof fetch>();
    const service = new VoiceProvidersService(
      db as unknown as ConstructorParameters<typeof VoiceProvidersService>[0],
      null,
      fetchMock,
    );

    await expect(service.testConnection('actor', 'SANDBOX')).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      service.save('actor', 'SANDBOX', {
        username: 'sandbox',
        voiceNumber: '',
        apiKey: 'test-only-value',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables SMS dispatch by default and rejects production activation flags', async () => {
    const disabled = smsPortFromEnvironment({});
    expect(disabled.provider).toBe('UNKNOWN');
    expect(await disabled.isReady()).toMatchObject({ enabled: false, ready: false });
    await expect(
      disabled.send({
        to: '+256700000000',
        body: 'test-only',
        idempotencyKey: 'test-only-key',
        organizationId: 'org',
        campaignId: 'campaign',
        recipientId: 'recipient',
      }),
    ).rejects.toThrow('sms_provider_unavailable');

    expect(smsPortFromEnvironment({ W504_SMS_FALLBACK_ENABLED: 'true' }).provider).toBe(
      'SYNTHETIC',
    );
    expect(
      smsPortFromEnvironment({
        W504_SMS_FALLBACK_ENABLED: 'true',
        NODE_ENV: 'production',
      }).provider,
    ).toBe('UNKNOWN');
  });

  it('wires callback receipts without a settlement or charging side effect', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AfricaTalkingCallbackModule) as readonly {
      readonly provide?: unknown;
      readonly inject?: readonly unknown[];
      readonly useFactory?: (...args: unknown[]) => unknown;
    }[];
    const receiptsProvider = providers.find((provider) => provider.provide === CallbackReceipts);
    expect(receiptsProvider?.inject).toEqual([DATABASE_CLIENT]);

    const factory = receiptsProvider?.useFactory;
    expect(factory).toBeTypeOf('function');
    const created = factory?.({}) as unknown as {
      readonly options?: { readonly settlement?: unknown };
    };
    expect(created).toBeInstanceOf(CallbackReceipts);
    expect(created.options?.settlement).toBeUndefined();
  });

  it('dedupes an exact callback replay to one durable receipt', async () => {
    // The fake models the database's (source, event_key) uniqueness constraint.
    const stored = new Map<string, unknown>();
    const executeRaw = vi.fn(async (_sql: unknown, ...values: unknown[]) => {
      const eventKey = values[3];
      if (typeof eventKey !== 'string') throw new Error('unexpected receipt insert');
      if (stored.has(eventKey)) return 0;
      stored.set(eventKey, values);
      return 1;
    });
    const db = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: executeRaw,
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    };
    const receipts = new CallbackReceipts(
      db as unknown as ConstructorParameters<typeof CallbackReceipts>[0],
    );
    const event = {
      source: CALLBACK_SOURCES.africasTalking,
      sessionId: 'ATVId_abc',
      eventKey: 'a'.repeat(64),
      state: 'COMPLETED' as const,
      receivedAt: new Date('2026-11-28T12:00:00.000Z'),
      occurredAt: new Date('2026-11-28T12:00:00.000Z'),
    };

    await receipts.receive(event);
    await receipts.receive({ ...event, receivedAt: new Date('2026-11-28T12:00:01.000Z') });

    expect(stored.size).toBe(1);
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });
});
