/**
 * Authenticated, read-only analytics over an organization.
 *
 * The organization id comes from the guarded path and is injected by
 * `CurrentOrganization`; no handler accepts an organization from a query or body
 * field. Every route declares `reporting:read`, and the service only reads from
 * the accepted W5-03 adapter. There are deliberately no mutation routes here.
 */

import { Controller, Get, Header, Inject, Param, Query, UseGuards } from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import {
  CurrentOrganization,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';
import type { OrganizationContext } from '../auth/principal.js';

import type {
  AnalyticsCampaignCallLogsResponseDto,
  AnalyticsCampaignResponseDto,
  AnalyticsCampaignsResponseDto,
  AnalyticsCallLogsResponseDto,
  AnalyticsPaginationQueryInput,
  AnalyticsQueryInput,
  AnalyticsSummaryResponseDto,
} from './analytics.dto.js';
import { AnalyticsService } from './analytics.service.js';

const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

@Controller()
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  /** `GET /organizations/:organizationId/analytics/summary` */
  @Get('organizations/:organizationId/analytics/summary')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  async summary(
    @CurrentOrganization() organization: OrganizationContext,
    @Query() query: AnalyticsQueryInput,
  ): Promise<AnalyticsSummaryResponseDto> {
    return this.analytics.summary(organization.organizationId, query);
  }

  /** `GET /organizations/:organizationId/analytics/campaigns` */
  @Get('organizations/:organizationId/analytics/campaigns')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  async campaigns(
    @CurrentOrganization() organization: OrganizationContext,
    @Query() query: AnalyticsQueryInput,
  ): Promise<AnalyticsCampaignsResponseDto> {
    return this.analytics.campaigns(organization.organizationId, query);
  }

  /** `GET /organizations/:organizationId/analytics/campaigns/:campaignId` */
  @Get('organizations/:organizationId/analytics/campaigns/:campaignId')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  async campaign(
    @CurrentOrganization() organization: OrganizationContext,
    @Param('campaignId') campaignId: string,
    @Query() query: AnalyticsQueryInput,
  ): Promise<AnalyticsCampaignResponseDto> {
    return this.analytics.campaign(organization.organizationId, campaignId, query);
  }

  /** `GET /organizations/:organizationId/analytics/calls` */
  @Get('organizations/:organizationId/analytics/calls')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  async callLogs(
    @CurrentOrganization() organization: OrganizationContext,
    @Query() query: AnalyticsPaginationQueryInput,
  ): Promise<AnalyticsCallLogsResponseDto> {
    return this.analytics.callLogs(organization.organizationId, query);
  }

  /** `GET /organizations/:organizationId/analytics/campaigns/:campaignId/calls` */
  @Get('organizations/:organizationId/analytics/campaigns/:campaignId/calls')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  async campaignCallLogs(
    @CurrentOrganization() organization: OrganizationContext,
    @Param('campaignId') campaignId: string,
    @Query() query: AnalyticsPaginationQueryInput,
  ): Promise<AnalyticsCampaignCallLogsResponseDto> {
    return this.analytics.campaignCallLogs(organization.organizationId, campaignId, query);
  }

  /** `GET /organizations/:organizationId/analytics/calls.csv` */
  @Get('organizations/:organizationId/analytics/calls.csv')
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('reporting:read')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="analytics-calls.csv"')
  @Header('Cache-Control', 'no-store')
  async csv(
    @CurrentOrganization() organization: OrganizationContext,
    @Query() query: AnalyticsQueryInput,
  ): Promise<string> {
    return this.analytics.csv(organization.organizationId, query);
  }
}
