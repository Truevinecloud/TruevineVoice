/**
 * Queue depth monitoring service for the worker.
 *
 * Creates read-only BullMQ Queue connections to collect waiting, active,
 * delayed, and failed job counts plus the age of the oldest waiting job.
 * All operations are read-only: no queue mutations, no job modifications.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { collectQueueDepth } from '@truevine/queue';

import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { REDIS_CLIENT } from '../tokens.js';
import type { Redis } from 'ioredis';

/**
 * Queue names monitored for observability.
 */
const MONITORED_QUEUES = [
  process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ?? 'campaign-execution',
];

/**
 * Collects queue depth metrics for monitored queues.
 *
 * Uses dedicated read-only Queue connections so observability reads never
 * interfere with job processing.
 */
@Injectable()
export class QueueMetricsService {
  private readonly logger = new Logger(QueueMetricsService.name);
  private queues: Queue[] = [];

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Initializes read-only queue connections for monitored queues. */
  async initialize(): Promise<void> {
    for (const queueName of MONITORED_QUEUES) {
      try {
        const queue = new Queue(queueName, {
          connection: this.redis,
          defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        });
        this.queues.push(queue);
        this.logger.log(`queue metrics initialized for ${queueName}`);
      } catch (error) {
        this.logger.warn(
          `failed to initialize queue metrics for ${queueName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Collects depth metrics for all monitored queues. */
  async collect(): Promise<Awaited<ReturnType<typeof collectQueueDepth>>[]> {
    const results: Awaited<ReturnType<typeof collectQueueDepth>>[] = [];
    for (const queue of this.queues) {
      try {
        const result = await collectQueueDepth(queue);
        results.push(result);
      } catch (error) {
        this.logger.warn(
          `queue metrics collection failed for ${queue.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return results;
  }

  /** Returns the number of queues being monitored. */
  get monitoredQueueCount(): number {
    return this.queues.length;
  }
}
