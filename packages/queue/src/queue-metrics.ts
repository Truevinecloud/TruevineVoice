/**
 * Queue depth monitoring for BullMQ queues.
 *
 * Collects waiting, active, delayed, and failed job counts plus the age of
 * the oldest waiting job. All reads are read-only: no queue mutations, no job
 * modifications, no side effects.
 *
 * Unavailable metrics are represented as `undefined`, never as zero.
 */

import type {
  QueueDepthSample,
  QueueMetricsSnapshot,
} from '@truevine/shared';

/**
 * BullMQ `getJobCounts()` returns an index signature; cast to the known shape.
 */
type JobCounts = {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
};

/** The read-only surface required to sample a queue's depth. */
export interface ReadOnlyQueue {
  readonly name: string;
  getWaiting(start: number, end: number): Promise<Array<{ readonly timestamp?: number }>>;
  getJobCounts(): Promise<Record<string, number>>;
}

/**
 * Collects queue depth metrics for a single BullMQ queue.
 *
 * Falls back gracefully: if any individual count is unavailable (e.g., the
 * method is not supported by the BullMQ version in use), that field is
 * `undefined` rather than throwing.
 */
export async function collectQueueDepth(
  queue: ReadOnlyQueue,
): Promise<QueueDepthSample> {
  let status: QueueDepthSample['status'] = 'ok';
  let error: QueueDepthSample['error'] | undefined;

  let waitingCount: number | undefined;
  let activeCount: number | undefined;
  let delayedCount: number | undefined;
  let failedCount: number | undefined;
  let oldestWaitingAgeMs: number | undefined;

  try {
    const counts = (await queue.getJobCounts()) as unknown as JobCounts;
    waitingCount = counts.waiting;
    activeCount = counts.active;
    delayedCount = counts.delayed;
    failedCount = counts.failed;
  } catch (err) {
    status = 'degraded';
    error = `getJobCounts failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Collect oldest waiting job age separately so a failure here doesn't
  // invalidate the other counts.
  try {
    const waitingJobs = await queue.getWaiting(0, 1);
    const oldest = waitingJobs[0];
    if (oldest !== undefined) {
      const timestamp = oldest.timestamp;
      if (typeof timestamp === 'number') {
        oldestWaitingAgeMs = Math.max(0, Date.now() - timestamp);
      }
    }
  } catch (err) {
    if (status === 'ok') {
      status = 'degraded';
      error = `getWaiting failed: ${err instanceof Error ? err.message : String(err)}`;
    } else if (error) {
      error += `; getWaiting failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    queueName: queue.name,
    timestamp: new Date().toISOString(),
    status,
    error,
    waiting: waitingCount,
    active: activeCount,
    delayed: delayedCount,
    failed: failedCount,
    oldestWaitingAgeMs,
  };
}

/**
 * Collects queue depth metrics for multiple BullMQ queues.
 */
export async function collectAllQueueDepths(
  queues: readonly ReadOnlyQueue[],
): Promise<QueueMetricsSnapshot> {
  const queuesResult: Record<string, QueueDepthSample> = {};
  for (const queue of queues) {
    const sample = await collectQueueDepth(queue);
    queuesResult[queue.name] = sample;
  }
  return {
    timestamp: new Date().toISOString(),
    queues: queuesResult,
  };
}

/**
 * Creates a read-only wrapper around a BullMQ queue for observability.
 *
 * The wrapper exposes only read methods, making it impossible to accidentally
 * mutate queue state from observability code.
 */
export function wrapReadOnly(queue: ReadOnlyQueue): ReadOnlyQueue {
  return {
    name: queue.name,
    getWaiting: (start: number, end: number) => queue.getWaiting(start, end),
    getJobCounts: () => queue.getJobCounts(),
  };
}
