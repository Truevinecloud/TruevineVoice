/**
 * Campaign feature module.
 *
 * Exports the service, not the store. Controllers in other modules that need
 * to know what a campaign is call `CampaignsService`; they never import a
 * persistence implementation (AGENTS.md 3).
 *
 * RBAC-003: this module is what gives `CAMPAIGN_MANAGER` real work to do. The
 * permission checks themselves live on the routes (`campaign:*` in
 * `campaigns.controller.ts`) and are enforced by `OrganizationGuard` from
 * `AuthModule` - this module adds no inline checks and none are needed.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { InfrastructureModule } from '../infrastructure/infrastructure.module.js';

import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';
import { PrismaCampaignStore } from './prisma-campaign.store.js';
import { CAMPAIGN_STORE } from './tokens.js';

@Module({
  // Explicit, even though `InfrastructureModule` is `@Global()`. Relying on a
  // global provider being registered before this module is initialised is an
  // ordering assumption, and it fails in a testing module that overrides the
  // client. Declaring the import states the dependency instead of implying it.
  imports: [AuthModule, InfrastructureModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, { provide: CAMPAIGN_STORE, useClass: PrismaCampaignStore }],
  exports: [CampaignsService],
})
export class CampaignsModule {}
