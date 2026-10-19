import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { BILLING_STORE } from './billing.store.js';
import { PrismaBillingStore } from './prisma-billing.store.js';
@Module({
  imports: [AuthModule, InfrastructureModule],
  controllers: [BillingController],
  providers: [BillingService, { provide: BILLING_STORE, useClass: PrismaBillingStore }],
})
export class BillingModule {}
