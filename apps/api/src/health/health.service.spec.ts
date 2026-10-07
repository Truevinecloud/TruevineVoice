import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { HealthService } from './health.service.js';

function buildService(overrides: {
  database: { $queryRaw: () => Promise<unknown> };
  redis: { ping: () => Promise<unknown> };
}): HealthService {
  const config: ApiConfig = {
    host: '127.0.0.1',
    port: 3001,
    environment: 'test',
    version: '0.1.0-test',
    databaseUrl: 'postgresql://unused/unused',
    redisUrl: 'redis://unused:6379',
    healthTimeoutMs: 50,
    serviceName: 'truevine-voice-api',
  };

  return new HealthService(config, overrides.database, overrides.redis);
}

const healthy = {
  database: { $queryRaw: async () => [{ ok: 1 }] },
  redis: { ping: async () => 'PONG' },
};

const degraded = {
  database: { $queryRaw: async () => [{ ok: 1 }] },
  redis: { ping: async () => Promise.reject(new Error('connect ECONNREFUSED')) },
};

describe('HealthService', () => {
  it('reports ok with a postgres and redis entry when every dependency answers', async () => {
    const report = await buildService(healthy).check();

    expect(report.status).toBe('ok');
    expect(report.service).toBe('truevine-voice-api');
    expect(report.version).toBe('0.1.0-test');
    expect(report.environment).toBe('test');
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(report.dependencies)).toEqual(['postgres', 'redis']);
    expect(report.dependencies.postgres?.status).toBe('up');
    expect(report.dependencies.redis?.status).toBe('up');
  });

  it('reports degraded and keeps the healthy dependency visible', async () => {
    const report = await buildService(degraded).check();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.postgres?.status).toBe('up');
    expect(report.dependencies.redis?.status).toBe('down');
    expect(report.dependencies.redis?.error).toBe('connect ECONNREFUSED');
  });

  it('produces an ISO-8601 timestamp', async () => {
    const report = await buildService(healthy).check();

    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('exports APP_CONFIG as a unique injection token', () => {
    expect(typeof APP_CONFIG).toBe('symbol');
  });
});
