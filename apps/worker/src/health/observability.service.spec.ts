import type { QueueDepthSample } from '@truevine/shared';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfig } from '../config/worker.config.js';
import { ObservabilityService } from './observability.service.js';
import type { QueueMetricsService } from './queue-metrics.service.js';

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

type QueueMetricsFake = {
  readonly initialize: QueueMetricsService['initialize'];
  readonly collect: QueueMetricsService['collect'];
  readonly monitoredQueueCount: number;
};

const asQueueMetrics = (fake: QueueMetricsFake): QueueMetricsService =>
  fake as unknown as QueueMetricsService;

const makeQueueMetrics = (samples: QueueDepthSample[] = []): QueueMetricsFake => ({
  initialize: vi.fn(async () => undefined),
  collect: vi.fn(async (): Promise<QueueDepthSample[]> => samples),
  monitoredQueueCount: samples.length,
});

const makeRedis = () => ({
  ping: vi.fn(async () => 'PONG'),
  disconnect: vi.fn(async () => undefined),
});

const asRedis = (fake: ReturnType<typeof makeRedis>): Redis => fake as unknown as Redis;

describe('ObservabilityService (worker)', () => {
  it('collects queue and host resource metrics', async () => {
    const queueMetrics = makeQueueMetrics([
      {
        queueName: 'campaign-execution',
        timestamp: new Date().toISOString(),
        status: 'ok',
        waiting: 10,
        active: 3,
        delayed: 2,
        failed: 1,
        oldestWaitingAgeMs: 5000,
        error: undefined,
      },
    ]);
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      asQueueMetrics(queueMetrics),
      asRedis(redis),
    );

    await service.onModuleInit();
    // Periodic collection begins after the configured interval. Perform one
    // explicit cycle so the read-only state snapshot has current samples.
    await service.collectOnce();

    const state = service.state;
    expect(state.samples['queue.waiting']?.value).toBe(10);
    expect(state.samples['queue.failed']?.value).toBe(1);
    expect(state.samples['queue.oldestWaitingAgeMs']?.value).toBe(5000);
    expect(state.samples['host.cpuPercent']).toBeDefined();
    expect(state.samples['host.memoryUsedPercent']).toBeDefined();

    service.onModuleDestroy();
  });

  it('records provider failures', async () => {
    const queueMetrics = makeQueueMetrics([]);
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      asQueueMetrics(queueMetrics),
      asRedis(redis),
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
    const queueMetrics = makeQueueMetrics([]);
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      asQueueMetrics(queueMetrics),
      asRedis(redis),
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
      asQueueMetrics(queueMetrics),
      asRedis(redis),
    );

    await service.onModuleInit();

    const state = await service.collectOnce();
    // waiting=200 breaches the critical threshold (100) for queue_depth_high,
    // but that rule deliberately requires sustained, consecutive breaches
    // before it transitions to `firing`. One cycle reports severity and the
    // breach without pretending the alert has fired.
    expect(state.overallSeverity).toBe('critical');
    const depth = state.evaluations.find((e) => e.ruleName === 'queue_depth_high');
    expect(depth?.breached).toBe(true);
    expect(depth?.severity).toBe('critical');
    expect(state.firing).toHaveLength(0);

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
      monitoredQueueCount: 1,
    };
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      asQueueMetrics(queueMetrics),
      asRedis(redis),
    );

    // Should not throw even though initialize fails
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    // Collection should still work (host resources available)
    const state = await service.collectOnce();
    expect(state).toBeDefined();

    service.onModuleDestroy();
  });

  it('stop is idempotent and does not throw', async () => {
    const queueMetrics = makeQueueMetrics([]);
    const redis = makeRedis();

    const service = new ObservabilityService(
      makeConfig(),
      asQueueMetrics(queueMetrics),
      asRedis(redis),
    );

    service.onModuleDestroy();
    service.onModuleDestroy();
    expect(true).toBe(true);
  });
});
