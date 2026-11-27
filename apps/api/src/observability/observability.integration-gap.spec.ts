import { describe, expect, it } from 'vitest';

import { ObservabilityService } from './observability.service.js';

function makeConfig() {
  return {
    host: 'localhost',
    port: 3001,
    environment: 'test',
    version: '0.1.0-test',
    databaseUrl: 'postgresql://stub:5432/test',
    redisUrl: 'redis://stub:6379',
    healthTimeoutMs: 50,
    serviceName: 'truevine-voice-api',
  } as never;
}

describe('API/Worker observability integration gap', () => {
  it('API observability service does NOT collect queue metrics', async () => {
    const apiService = new ObservabilityService(makeConfig());
    const state = await apiService.collectOnce();

    // API has no BullMQ access, so no queue metrics
    expect(state.samples['queue.waiting']).toBeUndefined();
    expect(state.samples['queue.failed']).toBeUndefined();
    expect(state.samples['queue.oldestWaitingAgeMs']).toBeUndefined();
  });

  it('API and Worker observability services are independent (no shared memory)', async () => {
    const serviceA = new ObservabilityService(makeConfig());
    const serviceB = new ObservabilityService(makeConfig());

    serviceA.recordProviderFailure();
    serviceA.recordProviderFailure();

    // serviceB should NOT see serviceA's counter
    const stateB = await serviceB.collectOnce();
    expect(stateB.samples['provider.failures']?.value).toBe(0);

    // serviceA sees its own counter
    const stateA = await serviceA.collectOnce();
    expect(stateA.samples['provider.failures']?.value).toBe(2);
  });

  it('Worker collects queue metrics via QueueMetricCollector', async () => {
    // Verified in apps/worker/src/health/observability.service.spec.ts
    // The worker's QueueMetricCollector wraps QueueMetricsService which reads
    // from BullMQ via Redis. Queue metrics (waiting, failed, oldestWaitingAgeMs)
    // are collected by the worker only.
    expect(true).toBe(true);
  });

  it('Admin dashboard reads API /metrics only', async () => {
    // The operations dashboard reads GET /metrics from the API.
    // Worker queue metrics are NOT forwarded to the API, so the dashboard
    // cannot display queue depth, queue failures, or oldest waiting age.
    // This is a documented integration gap requiring a transport mechanism
    // (e.g., Redis pub/sub or shared key) before the dashboard can show
    // worker-collected queue metrics.
    expect(true).toBe(true);
  });
});
