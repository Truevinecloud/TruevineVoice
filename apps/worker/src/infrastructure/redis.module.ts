import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createRedisClient, type Redis } from '@truevine/queue';

import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { REDIS_CLIENT } from '../tokens.js';

/**
 * Disconnects Redis on shutdown.
 *
 * Declared before the module so that the `@Module` decorator does not reference
 * a class that has not been initialised yet.
 */
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * Redis infrastructure for the worker.
 *
 * The worker talks to Redis through one long-lived client that is also the
 * client BullMQ will use (`createBullConnection` in `@truevine/queue`). No
 * queues are registered at this stage by design: business queues are introduced
 * together with the behaviour that produces them, not before.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): Redis => createRedisClient(config.redisUrl),
    },
    RedisLifecycle,
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
