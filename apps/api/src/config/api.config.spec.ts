import { describe, expect, it } from 'vitest';

import { API_SERVICE_NAME, loadApiConfig } from './api.config.js';

describe('loadApiConfig', () => {
  it('reads the required connection URLs', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(config.databaseUrl).toBe('postgresql://user:pass@localhost:5432/db');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.serviceName).toBe(API_SERVICE_NAME);
  });

  it('applies documented defaults', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://localhost/db',
      REDIS_URL: 'redis://localhost:6379',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3001);
    expect(config.environment).toBe('development');
    expect(config.healthTimeoutMs).toBe(2_000);
    expect(config.audioStorage).toBeNull();
    expect(config.audioTtsRegion).toBeNull();
    expect(config.paymentCredentialEncryptionKey).toBeNull();
  });

  it('accepts a configured 32-byte payment credential key', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      PAYMENT_CREDENTIAL_ENCRYPTION_KEY: key,
    });
    expect(config.paymentCredentialEncryptionKey).toBe(key);
  });

  it('requires the payment credential key in production', () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/PAYMENT_CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('rejects a malformed payment credential key instead of deriving one', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        PAYMENT_CREDENTIAL_ENCRYPTION_KEY: 'not-a-key',
      }),
    ).toThrow(/base64-encoded 32-byte key/);

    expect(() =>
      loadApiConfig({
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        PAYMENT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrow(/base64-encoded 32-byte key/);
  });

  it('enables only the audio capabilities with complete provider configuration', () => {
    const config = loadApiConfig({
      DATABASE_URL: 'postgresql://localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      AUDIO_STORAGE_BUCKET: 'private-audio',
      AUDIO_STORAGE_REGION: 'af-south-1',
      AUDIO_STORAGE_ENDPOINT: 'https://objects.example.invalid',
      AUDIO_STORAGE_FORCE_PATH_STYLE: 'true',
      AUDIO_TTS_REGION: 'af-south-1',
    });
    expect(config.audioStorage).toEqual({
      bucket: 'private-audio',
      region: 'af-south-1',
      endpoint: 'https://objects.example.invalid',
      forcePathStyle: true,
    });
    expect(config.audioTtsRegion).toBe('af-south-1');
  });

  it('requires a storage region when a bucket is configured', () => {
    expect(() =>
      loadApiConfig({
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        AUDIO_STORAGE_BUCKET: 'private-audio',
      }),
    ).toThrow(/AUDIO_STORAGE_REGION/);
  });

  it('lets explicit environment variables win', () => {
    const config = loadApiConfig({
      NODE_ENV: 'production',
      API_PORT: '8080',
      HEALTH_CHECK_TIMEOUT_MS: '500',
      APP_VERSION: '1.2.3',
      DATABASE_URL: 'postgresql://localhost/db',
      REDIS_URL: 'redis://localhost:6379',
      PAYMENT_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });

    expect(config.environment).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.healthTimeoutMs).toBe(500);
    expect(config.version).toBe('1.2.3');
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadApiConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(
      /Missing required environment variable "DATABASE_URL"/,
    );
  });

  it('fails fast when REDIS_URL is missing', () => {
    expect(() => loadApiConfig({ DATABASE_URL: 'postgresql://localhost/db' })).toThrow(
      /Missing required environment variable "REDIS_URL"/,
    );
  });

  it('rejects a non-numeric port rather than falling back silently', () => {
    expect(() =>
      loadApiConfig({
        API_PORT: 'three thousand',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/must be a positive integer/);
  });
});
