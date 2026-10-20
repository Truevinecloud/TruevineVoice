import { Module } from '@nestjs/common';
import { BillingModule } from './billing/billing.module.js';

import { AppConfigModule } from './config/app-config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CampaignsModule } from './campaigns/campaigns.module.js';
import { HealthModule } from './health/health.module.js';
import { InfrastructureModule } from './infrastructure/infrastructure.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { OperationsModule } from './operations/operations.module.js';

/**
 * Root API module.
 *
 * Truevine Voice is a modular monolith: feature modules live in `src/modules/*`
 * as they are introduced, and this module only wires them together. Cross-module
 * access goes through exported providers, never through direct imports of another
 * module's internals.
 */
@Module({
  imports: [
    AppConfigModule,
    InfrastructureModule,
    HealthModule,
    AuthModule,
    OrganizationsModule,
    CampaignsModule,
    BillingModule,
    OperationsModule,
  ],
})
export class AppModule {}
