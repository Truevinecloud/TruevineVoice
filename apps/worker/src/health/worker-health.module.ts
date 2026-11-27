import { Module } from '@nestjs/common';

import { QueueMetricsService } from './queue-metrics.service.js';
import { WorkerReadinessService } from './worker-readiness.service.js';
import { ObservabilityService } from './observability.service.js';

/**
 * Readiness reporting for the worker process.
 *
 * Includes queue depth monitoring via read-only BullMQ Queue connections
 * and observability collection (metrics, alert evaluation, notification).
 */
@Module({
  providers: [
    WorkerReadinessService,
    QueueMetricsService,
    ObservabilityService,
  ],
  exports: [WorkerReadinessService, QueueMetricsService, ObservabilityService],
})
export class WorkerHealthModule {}
