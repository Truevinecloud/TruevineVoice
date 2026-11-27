import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config/worker.config.js';
import { ObservabilityService } from './observability.service.js';

const makeConfig = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  environment: 'test',
  version: '0.1.0-test',
  redisUrl: 'redis://stub:6379',
  databaseUrl: 'postgresql://stub:5432/test',
  workerConcurrency: 1,
  maxRetryAttempts: 1,
  retryBackoffMs: 100,
  rateLimitMax: 1,
  rateLimitDurationMs: 1000,
  healthTimeoutMs: 50,
  serviceName: 'truevine-voice-worker',
  ...overrides,
});

const makeQueueMetrics = (): Pick<QueueMetricsService, 'initialize' | 'collect'> => ({
  initialize: vi.fn(async () => undefined),
  collect: vi.fn(async () => ({
    queueName: 'campaign-execution',
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    oldestWaitingAgeMs: undefined,
    error: undefined,
  })),
});

const makeRedis = (): Pick<Redis, 'ping' | 'disconnect'> => ({
  ping: vi.fn(async () => 'PONG'),
  disconnect: vi.fn(async () => undefined),
});

describe('ObservabilityService (worker)', () => {
  it('collects queue and host resource metrics', async () => {
    const queueMetrics = makeQueueMetrics();
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    await service.onModuleInit();

    const state = service.state;
    expect(state.samples['queue.waiting']?.value).toBe(10);
    expect(state.samples['queue.failed']?.value).toBe(1);
    expect(state.samples['queue.oldestWaitingAgeMs']?.value).toBe(5000);
    expect(state.samples['host.cpuPercent']).toBeDefined();
    expect(state.samples['host.memoryUsedPercent']).toBeDefined();

    service.onModuleDestroy();
  });

  it('records provider failures', async () => {
    const queueMetrics = makeQueueMetrics();
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    await service.onModuleInit();

    service.recordProviderFailure();
    service.recordProviderFailure();

    const state = await service.collectOnce();
    expect(state.samples['provider.failures']?.value).toBe(2);

    // After snapshot, counter resets
    const state2 = await service.collectOnce();
    expect(state2.samples['provider.failures']?.value).toBe(0);

    service.onModuleDestroy();
  });

  it('records payment failures', async () => {
    const queueMetrics = makeQueueMetrics();
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    await service.onModuleInit();

    service.recordPaymentFailure();

    const state = await service.collectOnce();
    expect(state.samples['payment.failures']?.value).toBe(1);

    service.onModuleDestroy();
  });

  it('reports overall severity', async () => {
    const queueMetrics = makeQueueMetrics([
      {
        queueName: 'campaign-execution',
        timestamp: new Date().toISOString(),
        status: 'ok',
        waiting: 200,
        active: 0,
        delayed: 0,
        failed: 0,
        oldestWaitingAgeMs: undefined,
        error: undefined,
      },
    ]);
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    await service.onModuleInit();

    const state = await service.collectOnce();
    // waiting=200 breaches critical threshold (100) for queue_depth_high
    expect(state.overallSeverity).toBe('critical');
    expect(state.firing.length).toBeGreaterThan(0);

    service.onModuleDestroy();
  });

  it('handles queue metrics collection failure gracefully', async () => {
    const queueMetrics = {
      initialize: vi.fn(async () => {
        throw new Error('redis down');
      }),
      collect: vi.fn(async () => {
        throw new Error('queue unavailable');
      }),
    } as Pick<QueueMetricsService, 'initialize' | 'collect'>;
    const redis = {
      ping: vi.fn(async () => 'PONG'),
      disconnect: vi.fn(async () => undefined),
    } as Pick<Redis, 'ping' | 'disconnect'>;

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    // Should not throw even though initialize fails
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    // Collection should still work (host resources available)
    const state = await service.collectOnce();
    expect(state).toBeDefined();

    service.onModuleDestroy();
  });

  it('stop is idempotent and does not throw', async () => {
    const queueMetrics = makeQueueMetrics();
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      queueMetrics as unknown as QueueMetricsService,
      redis as unknown as Redis,
    );

    service.onModuleDestroy();
    service.onModuleDestroy();
    expect(true).toBe(true);
  });
});
