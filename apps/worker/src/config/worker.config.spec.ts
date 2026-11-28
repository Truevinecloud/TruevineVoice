import { describe, expect, it } from 'vitest';

import { WORKER_SERVICE_NAME, loadWorkerConfig } from './worker.config.js';

describe('loadWorkerConfig', () => {
  const env = {
    REDIS_URL: 'redis://localhost:6379',
    DATABASE_URL: 'postgresql://truevine:truevine@localhost:55432/truevine_voice?schema=public',
  };

  it('reads required URLs and applies defaults', () => {
    const config = loadWorkerConfig(env);

    expect(config.redisUrl).toBe(env.REDIS_URL);
    expect(config.databaseUrl).toBe(env.DATABASE_URL);
    expect(config.environment).toBe('development');
    expect(config.version).toBe('0.1.0');
    expect(config.healthTimeoutMs).toBe(2_000);
    expect(config.workerConcurrency).toBe(4);
    expect(config.maxRetryAttempts).toBe(3);
    expect(config.retryBackoffMs).toBe(1_000);
    expect(config.rateLimitMax).toBe(10);
    expect(config.rateLimitDurationMs).toBe(1_000);
    expect(config.observabilityIntervalMs).toBe(30_000);
    expect(config.serviceName).toBe(WORKER_SERVICE_NAME);
  });

  it('fails fast when REDIS_URL is missing', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: env.DATABASE_URL })).toThrow(
      /Missing required environment variable "REDIS_URL"/,
    );
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadWorkerConfig({ REDIS_URL: env.REDIS_URL })).toThrow(
      /Missing required environment variable "DATABASE_URL"/,
    );
  });
});
