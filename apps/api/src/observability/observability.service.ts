/**
 * Observability service for the API process.
 *
 * Collects host resource metrics, evaluates them against alert rules, and
 * notifies on state changes. Runs as a NestJS injectable with lifecycle hooks.
 *
 * The API process does not have direct BullMQ access, so queue depth metrics
 * are not collected here (they are collected by the worker). Host resource
 * metrics and failure counters are collected locally.
 *
 * Monitoring failures never interrupt API availability, authentication, or
 * payment processing. Collection is best-effort.
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

import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';

/** Default collection interval: 30 seconds. */
const DEFAULT_COLLECTION_INTERVAL_MS = 30_000;

/**
 * NestJS observability service for the API.
 *
 * Wires together host resources, failure counters, alert evaluation, and
 * structured-log notification.
 */
@Injectable()
export class ObservabilityService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly service: AlertEvaluationService;
  private readonly providerFailures: ProviderFailureCounter;
  private readonly paymentFailures: PaymentFailureCounter;

  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {
    const collectors: MetricCollector[] = [
      new HostResourceCollector(),
    ];

    this.providerFailures = new ProviderFailureCounter();
    this.paymentFailures = new PaymentFailureCounter();

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

    this.service = new AlertEvaluationService(
      {
        collectionIntervalMs: DEFAULT_COLLECTION_INTERVAL_MS,
        rules: DEFAULT_ALERT_RULES,
      },
      collectors,
      new StructuredLogNotifier(),
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
    this.service.start();
    this.logger.log(
      `observability started (intervalMs=${DEFAULT_COLLECTION_INTERVAL_MS})`,
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
