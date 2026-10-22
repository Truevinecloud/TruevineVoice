import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { PrismaSupportStore } from './prisma-support.store.js';
import { SupportController } from './support.controller.js';
import { PrismaSupportAccessStore } from './prisma-support-access.store.js';
import { SupportAccessGuard } from './support-access.guard.js';
import { SupportAccessService } from './support-access.service.js';
import { SUPPORT_ACCESS_STORE } from './support-access.store.js';
import { SupportRateLimitGuard } from './support-rate-limit.guard.js';
import { SupportService } from './support.service.js';
import { SUPPORT_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [SupportController],
  providers: [
    SupportService,
    SupportAccessService,
    SupportAccessGuard,
    SupportRateLimitGuard,
    { provide: SUPPORT_STORE, useClass: PrismaSupportStore },
    { provide: SUPPORT_ACCESS_STORE, useClass: PrismaSupportAccessStore },
  ],
})
export class SupportModule {}
