/**
 * Campaigns under an organization.
 *
 * Every route declares the permission it needs with
 * `@RequireOrganizationPermission`. That declaration is what the guard reads;
 * there is no inline permission check anywhere in this controller, because an
 * inline check is one somebody forgets to update when the route changes.
 *
 * The organization id always comes from the path and is never read from a body
 * or query field. The guard has already proved the caller holds a membership in
 * it before any handler runs.
 *
 * RBAC-003: `CAMPAIGN_MANAGER` reaches every route below through
 * `campaign:read` / `campaign:create` / `campaign:update` / `campaign:delete`.
 * Every other organization role is refused by the guard, not by a check in a
 * handler.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import {
  CurrentOrganization,
  CurrentPrincipal,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';

import { CampaignsService, type CampaignView } from './campaigns.service.js';

/**
 * Guards applied to every campaign-scoped route.
 *
 * `CsrfGuard` is part of this list, not an afterthought. Without it every
 * mutation below - create, rename, status change, delete - is forgeable from a
 * same-site context, because the session cookie alone is the credential.
 */
const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

@Controller()
export class CampaignsController {
  constructor(@Inject(CampaignsService) private readonly campaigns: CampaignsService) {}

  /** `GET /organizations/:organizationId/campaigns` */
  @Get('organizations/:organizationId/campaigns')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:read')
  async list(
    @CurrentOrganization() context: { organizationId: string },
  ): Promise<readonly CampaignView[]> {
    return this.campaigns.list(context.organizationId);
  }

  /** `POST /organizations/:organizationId/campaigns` */
  @Post('organizations/:organizationId/campaigns')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:create')
  async create(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Body() body: { readonly name?: unknown },
  ): Promise<CampaignView> {
    return this.campaigns.create(context.organizationId, principal.userId, body.name);
  }

  /** `GET /organizations/:organizationId/campaigns/:campaignId` */
  @Get('organizations/:organizationId/campaigns/:campaignId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:read')
  async get(
    @CurrentOrganization() context: { organizationId: string },
    @Param('campaignId') campaignId: string,
  ): Promise<CampaignView> {
    return this.campaigns.get(context.organizationId, campaignId);
  }

  /** `PATCH /organizations/:organizationId/campaigns/:campaignId` */
  @Patch('organizations/:organizationId/campaigns/:campaignId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:update')
  async update(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Param('campaignId') campaignId: string,
    @Body() body: { readonly name?: unknown; readonly status?: unknown },
  ): Promise<CampaignView> {
    return this.campaigns.update(context.organizationId, principal.userId, campaignId, {
      name: body.name,
      status: body.status,
    });
  }

  /** `DELETE /organizations/:organizationId/campaigns/:campaignId` */
  @Delete('organizations/:organizationId/campaigns/:campaignId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:delete')
  async remove(
    @CurrentOrganization() context: { organizationId: string },
    @CurrentPrincipal() principal: { userId: string },
    @Param('campaignId') campaignId: string,
  ): Promise<void> {
    await this.campaigns.remove(context.organizationId, principal.userId, campaignId);
  }
}
