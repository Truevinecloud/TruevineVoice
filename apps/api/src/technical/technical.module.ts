import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { HealthModule } from '../health/health.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { PrismaTechnicalStore } from './prisma-technical.store.js';
import { TechnicalController } from './technical.controller.js';
import { TechnicalRateLimitGuard } from './technical-rate-limit.guard.js';
import { TechnicalService } from './technical.service.js';
import { TECHNICAL_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, HealthModule, InfrastructureModule],
  controllers: [TechnicalController],
  providers: [
    TechnicalService,
    TechnicalRateLimitGuard,
    { provide: TECHNICAL_STORE, useClass: PrismaTechnicalStore },
  ],
})
export class TechnicalModule {}
