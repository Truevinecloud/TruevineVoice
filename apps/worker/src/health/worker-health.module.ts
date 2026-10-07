import { Module } from '@nestjs/common';

import { WorkerReadinessService } from './worker-readiness.service.js';

/** Readiness reporting for the worker process. */
@Module({
  providers: [WorkerReadinessService],
  exports: [WorkerReadinessService],
})
export class WorkerHealthModule {}
