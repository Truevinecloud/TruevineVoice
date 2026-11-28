/**
 * Observability service for the worker process.
 *
 * Collects queue depth and host resource metrics, evaluates them against
 * alert rules, and notifies on state changes. Runs as a NestJS injectable
 * with lifecycle hooks: collection starts on module init and stops on module
 * destroy.
 *
 * Monitoring failures never interrupt campaign execution, payment processing,
 * or authentication. Collection is best-effort: unavailable metrics are
 * reported as `undefined`, never as zero or healthy.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import {
  AlertEvaluationService,
  DEFAULT_ALERT_RULES,
  HostResourceCollector,
  PaymentFailureCounter,
  ProviderFailureCounter,
  StructuredLogNotifier,
  type MetricCollector,
} from '@truevine/shared';

import { QueueMetricsService } from './queue-metrics.service.js';
import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { REDIS_CLIENT } from '../tokens.js';
import type { Redis } from 'ioredis';

/** Default collection interval: 30 seconds. */
const DEFAULT_COLLECTION_INTERVAL_MS = 30_000;

/**
 * NestJS observability service for the worker.
 *
 * Wires together queue metrics, host resources, failure counters, alert
 * evaluation, and structured-log notification.
 */
@Injectable()
export class ObservabilityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly service: AlertEvaluationService;
  private readonly providerFailures: ProviderFailureCounter;
  private readonly paymentFailures: PaymentFailureCounter;

  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly queueMetrics: QueueMetricsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const collectors: MetricCollector[] = [
      new HostResourceCollector(),
    ];

    // Queue metric collector: wraps the worker's QueueMetricsService
    collectors.push({
      name: 'queue-metrics',
      collect: async () => {
        const samples = await this.queueMetrics.collect();
        const result: Record<string, { value: number | undefined; status: 'ok' | 'degraded' | 'unknown' }> = {};

        for (const sample of samples) {
          const prefix = `queue:${sample.queueName}`;
          result[`${prefix}.waiting`] = {
            value: sample.waiting,
            status: sample.status,
          };
          result[`${prefix}.failed`] = {
            value: sample.failed,
            status: sample.status,
          };
          result[`${prefix}.oldestWaitingAgeMs`] = {
            value: sample.oldestWaitingAgeMs,
            status: sample.status,
          };

          // Also populate unqualified names for the first (primary) queue
          // so existing alert rules (queue.waiting, queue.failed, ...) apply.
          if (sample.queueName === this.primaryQueueName) {
            result['queue.waiting'] = {
              value: sample.waiting,
              status: sample.status,
            };
            result['queue.failed'] = {
              value: sample.failed,
              status: sample.status,
            };
            result['queue.oldestWaitingAgeMs'] = {
              value: sample.oldestWaitingAgeMs,
              status: sample.status,
            };
          }
        }

        return result;
      },
    });

    this.providerFailures = new ProviderFailureCounter();
    this.paymentFailures = new PaymentFailureCounter();

    // Provider and payment failure counters are read on each cycle and reset
    // so each cycle reports failures observed since the previous collection.
    collectors.push({
      name: 'provider-failures',
      collect: async () => ({
        'provider.failures': {
          value: this.providerFailures.snapshot(),
          status: 'ok',
        },
      }),
    });

    collectors.push({
      name: 'payment-failures',
      collect: async () => ({
        'payment.failures': {
          value: this.paymentFailures.snapshot(),
          status: 'ok',
        },
      }),
    });

    const collectionIntervalMs =
      config.observabilityIntervalMs ?? DEFAULT_COLLECTION_INTERVAL_MS;

    this.service = new AlertEvaluationService(
      {
        collectionIntervalMs,
        rules: DEFAULT_ALERT_RULES,
      },
      collectors,
      new StructuredLogNotifier(),
    );
  }

  /** Primary monitored queue name (matches QueueMetricsService convention). */
  get primaryQueueName(): string {
    return (
      process.env['CAMPAIGN_EXECUTION_QUEUE_NAME'] ?? 'campaign-execution'
    );
  }

  /** Current observability state for dashboard consumers. */
  get state() {
    return this.service.state;
  }

  /** Whether the service is currently collecting. */
  get isCollecting(): boolean {
    return this.service.isCollecting;
  }

  /** Records a provider failure observation for alerting. */
  recordProviderFailure(): void {
    this.providerFailures.record();
  }

  /** Records a payment failure observation for alerting. */
  recordPaymentFailure(): void {
    this.paymentFailures.record();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queueMetrics.initialize();
    } catch (error) {
      this.logger.warn(
        `queue metrics initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.service.start();
    this.logger.log(
      `observability started (intervalMs=${this.config.observabilityIntervalMs ?? DEFAULT_COLLECTION_INTERVAL_MS})`,
    );
  }

  onModuleDestroy(): void {
    this.service.stop();
    this.logger.log('observability stopped');
  }

  /** Perform one collection cycle on demand (for testing/on-demand checks). */
  async collectOnce() {
    return this.service.collectOnce();
  }
}
