import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';
import { BillingAdminController } from './billing-admin.controller.js';
import { BillingAdminService } from './billing-admin.service.js';
import { PrismaBillingAdminStore } from './prisma-billing-admin.store.js';
import { BILLING_ADMIN_STORE } from './tokens.js';

@Module({
  imports: [AuthModule, InfrastructureModule, AuditModule],
  controllers: [BillingAdminController],
  providers: [BillingAdminService, { provide: BILLING_ADMIN_STORE, useClass: PrismaBillingAdminStore }],
  exports: [BillingAdminService],
})
export class BillingAdminModule {}
