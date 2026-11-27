import { describe, expect, it } from 'vitest';

import { collectQueueDepth, type ReadOnlyQueue, wrapReadOnly } from './queue-metrics.js';

describe('queue metrics', () => {
  const makeFakeQueue = (overrides: Partial<ReadOnlyQueue> = {}): ReadOnlyQueue =>
    ({
      name: 'test-queue',
      getWaiting: async () => [],
      getJobCounts: async () => ({
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        completed: 0,
        paused: 0,
      }),
      ...overrides,
    } as ReadOnlyQueue);

  it('collects zero counts from an idle queue', async () => {
    const queue = makeFakeQueue();
    const sample = await collectQueueDepth(queue as unknown as QueueType);

    expect(sample.queueName).toBe('test-queue');
    expect(sample.status).toBe('ok');
    expect(sample.waiting).toBe(0);
    expect(sample.active).toBe(0);
    expect(sample.delayed).toBe(0);
    expect(sample.failed).toBe(0);
    expect(sample.oldestWaitingAgeMs).toBeUndefined();
    expect(typeof sample.timestamp).toBe('string');
  });

  it('collects non-zero counts', async () => {
    const queue = makeFakeQueue({
      getJobCounts: async () => ({
        waiting: 10,
        active: 3,
        delayed: 2,
        failed: 1,
        completed: 100,
        paused: 0,
      }),
      getWaiting: async () => [{ timestamp: Date.now() - 5000 }],
    });

    const sample = await collectQueueDepth(queue as unknown as QueueType);

    expect(sample.waiting).toBe(10);
    expect(sample.active).toBe(3);
    expect(sample.delayed).toBe(2);
    expect(sample.failed).toBe(1);
    expect(sample.oldestWaitingAgeMs).toBeGreaterThanOrEqual(0);
    expect(sample.oldestWaitingAgeMs).toBeLessThan(10_000);
  });

  it('degrades gracefully when getJobCounts throws', async () => {
    const queue = makeFakeQueue({
      getJobCounts: async () => {
        throw new Error('connection lost');
      },
    });

    const sample = await collectQueueDepth(queue as unknown as QueueType);

    expect(sample.status).toBe('degraded');
    expect(sample.error).toContain('connection lost');
    expect(sample.waiting).toBeUndefined();
  });

  it('degrades gracefully when getWaiting throws but getJobCounts succeeds', async () => {
    const queue = makeFakeQueue({
      getJobCounts: async () => ({ waiting: 5, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 }),
      getWaiting: async () => {
        throw new Error('scan failed');
      },
    });

    const sample = await collectQueueDepth(queue as unknown as QueueType);

    expect(sample.status).toBe('degraded');
    expect(sample.waiting).toBe(5);
    expect(sample.oldestWaitingAgeMs).toBeUndefined();
    expect(sample.error).toContain('scan failed');
  });

  it('wrapReadOnly returns a read-only wrapper', () => {
    const fakeQueue = {
      name: 'wrapped-queue',
      getWaiting: async () => [],
      getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 }),
    } as unknown as QueueType;

    const wrapped = wrapReadOnly(fakeQueue);
    expect(wrapped.name).toBe('wrapped-queue');
    expect(typeof wrapped.getWaiting).toBe('function');
    expect(typeof wrapped.getJobCounts).toBe('function');
  });
});

// Type alias for test compatibility: BullMQ Queue type not imported to avoid
// dependency on ioredis in unit tests.
type QueueType = {
  name: string;
  getWaiting(start: number, end: number): Promise<Array<{ readonly timestamp?: number }>>;
  getJobCounts(): Promise<{
    readonly waiting: number;
    readonly active: number;
    readonly delayed: number;
    readonly failed: number;
    readonly completed: number;
    readonly paused: number;
  }>;
};
