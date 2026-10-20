import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { HealthModule } from '../health/health.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { OperationsController } from './operations.controller.js';
import { OperationsService } from './operations.service.js';
import { PrismaOperationsStore } from './prisma-operations.store.js';
import { OPERATIONS_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, HealthModule, InfrastructureModule],
  controllers: [OperationsController],
  providers: [OperationsService, { provide: OPERATIONS_STORE, useClass: PrismaOperationsStore }],
})
export class OperationsModule {}
