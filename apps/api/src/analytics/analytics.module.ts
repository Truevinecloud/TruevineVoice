/**
 * Analytics feature module.
 *
 * The only production dependency is the already-accepted W5-03B read adapter.
 * Authorization comes from the exported guards in `AuthModule`, and the Prisma
 * client comes from `InfrastructureModule`. This module adds no persistence code
 * and no financial mutation path.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { DATABASE_CLIENT } from '../tokens.js';

import { AnalyticsController } from './analytics.controller.js';
import { PrismaAnalyticsReadAdapter, type AnalyticsDatabase } from './analytics-read-adapter.js';
import { AnalyticsService } from './analytics.service.js';
import { ANALYTICS_READER } from './analytics.tokens.js';

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    {
      provide: ANALYTICS_READER,
      inject: [DATABASE_CLIENT],
      useFactory: (database: unknown) =>
        new PrismaAnalyticsReadAdapter(database as AnalyticsDatabase),
    },
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
