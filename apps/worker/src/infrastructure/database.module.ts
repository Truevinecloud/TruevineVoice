import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';

import { WORKER_CONFIG } from '../config/worker-config.module.js';
import type { WorkerConfig } from '../config/worker.config.js';
import { DATABASE_CLIENT } from '../tokens.js';

class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): PrismaClient =>
        createDatabaseClient(config.databaseUrl),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}