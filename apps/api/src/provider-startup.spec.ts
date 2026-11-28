import { Test, type TestingModule } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { AppModule } from './app.module.js';
import {
  VoiceProvidersService,
  VOICE_KEY,
} from './voice-providers/voice-providers.service.js';
import { SMS_PORT } from './sms/sms-tokens.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from './tokens.js';

const MANAGED_ENV = [
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'WEB_PUBLIC_URL',
  'PAYMENT_CREDENTIAL_ENCRYPTION_KEY',
  'EMAIL_TRANSPORT',
  'AT_CALLBACK_API_KEY',
  'VOICE_CREDENTIAL_ENCRYPTION_KEY',
  'W504_SMS_FALLBACK_ENABLED',
  'W504_SMS_BILLING_AUTHORIZED',
  'W502_SYNTHETIC_PAYMENTS_ENABLED',
  'W502_SYNTHETIC_VERIFICATION_KEY',
  'EXPECTED_DATABASE_NAME',
  'AUDIO_STORAGE_BACKEND',
  'AUDIO_STORAGE_BUCKET',
  'AUDIO_STORAGE_REGION',
  'AUDIO_TTS_REGION',
] as const;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('API startup with all commercial providers disabled', () => {
  let originalEnv: Map<string, string | undefined> = new Map();

  function useProductionEnvironmentWithoutProviderCredentials(): void {
    originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
    for (const key of MANAGED_ENV) setEnv(key, undefined);
    setEnv('NODE_ENV', 'production');
    setEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/startup_test');
    setEnv('REDIS_URL', 'redis://127.0.0.1:1');
    setEnv('WEB_PUBLIC_URL', 'https://app.example.test');
    setEnv('EMAIL_TRANSPORT', 'none');
    // Existing payment-credential configuration is a separate, already-wired
    // production prerequisite. This deterministic test-only key is never used
    // to store or encrypt a real credential.
    setEnv('PAYMENT_CREDENTIAL_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  }

  function restoreEnvironment(): void {
    for (const [key, value] of originalEnv ?? []) setEnv(key, value);
  }

  it('builds and initializes AppModule without provider keys or outbound requests', async () => {
    useProductionEnvironmentWithoutProviderCredentials();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    const database = {
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(database)),
      $disconnect: vi.fn(async () => undefined),
    };
    const redis = { disconnect: vi.fn() };
    let moduleRef: TestingModule | undefined;

    try {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_CLIENT)
        .useValue(database)
        .overrideProvider(REDIS_CLIENT)
        .useValue(redis)
        .compile();

      await moduleRef.init();

      expect(moduleRef.get<Buffer | null>(VOICE_KEY, { strict: false })).toBeNull();
      expect(moduleRef.get<string | null>('AT_CALLBACK_API_KEY', { strict: false })).toBeNull();
      expect(moduleRef.get(VoiceProvidersService, { strict: false })).toBeInstanceOf(
        VoiceProvidersService,
      );

      const smsPort = moduleRef.get<{
        readonly provider: string;
        send(request: unknown): Promise<unknown>;
      }>(SMS_PORT, { strict: false });
      expect(smsPort.provider).toBe('UNKNOWN');
      await expect(
        smsPort.send({
          to: '+256700000000',
          body: 'test-only',
          idempotencyKey: 'test-only-key',
          organizationId: 'org',
          campaignId: 'campaign',
          recipientId: 'recipient',
        }),
      ).rejects.toThrow('sms_provider_unavailable');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await moduleRef?.close();
      vi.restoreAllMocks();
      restoreEnvironment();
    }
  });
});
