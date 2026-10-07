import { describe, expect, it } from 'vitest';

import { WORKER_SERVICE_NAME, loadWorkerConfig } from './worker.config.js';

describe('loadWorkerConfig', () => {
  it('reads REDIS_URL and applies defaults', () => {
    const config = loadWorkerConfig({ REDIS_URL: 'redis://localhost:6379' });

    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.environment).toBe('development');
    expect(config.version).toBe('0.1.0');
    expect(config.healthTimeoutMs).toBe(2_000);
    expect(config.serviceName).toBe(WORKER_SERVICE_NAME);
  });

  it('fails fast when REDIS_URL is missing', () => {
    expect(() => loadWorkerConfig({})).toThrow(/Missing required environment variable "REDIS_URL"/);
  });
});
