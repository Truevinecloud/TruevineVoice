import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { createRedisClient, type Redis } from '@truevine/queue';

import { APP_CONFIG } from '../config/app-config.module.js';
import type { ApiConfig } from '../config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../tokens.js';

/**
 * Closes the infrastructure clients on shutdown.
 *
 * Declared before the module so that the `@Module` decorator does not reference
 * a class that has not been initialised yet.
 */
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.$disconnect();
    this.redis.disconnect();
  }
}

/**
 * Owns the lifecycle of the API's infrastructure clients.
 *
 * Connection construction lives here (and only here) so that infrastructure is
 * a swappable adapter rather than something every service wires up itself.
 * Clients are always closed on shutdown so that the process exits promptly.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): PrismaClient => createDatabaseClient(config.databaseUrl),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): Redis => createRedisClient(config.redisUrl),
    },
    InfrastructureLifecycle,
  ],
  exports: [DATABASE_CLIENT, REDIS_CLIENT],
})
export class InfrastructureModule {}
