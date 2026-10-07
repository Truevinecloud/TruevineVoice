import { Module } from '@nestjs/common';

import { WorkerConfigModule } from './config/worker-config.module.js';
import { WorkerHealthModule } from './health/worker-health.module.js';
import { RedisModule } from './infrastructure/redis.module.js';

/**
 * Root worker module.
 *
 * The worker is a modular-monolith process with no HTTP surface. Business job
 * processors are added later as modules that register BullMQ processors; none
 * exist at the foundation stage.
 */
@Module({
  imports: [WorkerConfigModule, RedisModule, WorkerHealthModule],
})
export class AppModule {}
