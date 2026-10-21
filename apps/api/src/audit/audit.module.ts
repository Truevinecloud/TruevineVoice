import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { AuditController } from './audit.controller.js';
import { AuditRateLimitGuard } from './audit-rate-limit.guard.js';
import { AuditService } from './audit.service.js';
import { PrismaAuditorStore } from './prisma-auditor.store.js';
import { AUDITOR_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditRateLimitGuard,
    { provide: AUDITOR_STORE, useClass: PrismaAuditorStore },
  ],
})
export class AuditModule {}
