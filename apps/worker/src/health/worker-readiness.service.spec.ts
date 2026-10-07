import { describe, expect, it } from 'vitest';

import type { WorkerConfig } from '../config/worker.config.js';
import { WorkerReadinessService } from './worker-readiness.service.js';

function buildService(ping: () => Promise<unknown>): WorkerReadinessService {
  const config: WorkerConfig = {
    environment: 'test',
    version: '0.1.0-test',
    redisUrl: 'redis://stub:6379',
    healthTimeoutMs: 50,
    serviceName: 'truevine-voice-worker',
  };

  return new WorkerReadinessService(config, { ping });
}

describe('WorkerReadinessService', () => {
  it('is ok when Redis answers', async () => {
    const service = buildService(async () => 'PONG');

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.dependencies.redis?.status).toBe('up');
    expect(service.status).toBe('ok');
  });

  it('is degraded when Redis is unreachable and records the reason', async () => {
    const service = buildService(async () => Promise.reject(new Error('connect ECONNREFUSED')));

    const report = await service.check();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.redis?.status).toBe('down');
    expect(report.dependencies.redis?.error).toBe('connect ECONNREFUSED');
    expect(service.status).toBe('degraded');
  });

  it('does not throw from onApplicationBootstrap when Redis is down', async () => {
    const service = buildService(async () => Promise.reject(new Error('redis down')));

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
