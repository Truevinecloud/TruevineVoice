import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { HealthReport } from '@truevine/shared';
import type { PlatformRole } from '@truevine/auth';

import { HealthService } from '../health/health.service.js';
import { EMERGENCY_STOP_REASON_CODES, type CampaignOperationRecord } from './operations.store.js';
import { OPERATIONS_STORE } from './tokens.js';
import type { OperationsStore } from './operations.store.js';

@Injectable()
export class OperationsService {
  constructor(
    @Inject(OPERATIONS_STORE) private readonly operations: OperationsStore,
    @Inject(HealthService) private readonly health: HealthService,
  ) {}

  async listOrganizations() {
    const organizations = await this.operations.listOrganizations();
    return organizations.map((organization) => ({
      ...organization,
      createdAt: organization.createdAt.toISOString(),
    }));
  }

  async listCampaigns() {
    const campaigns = await this.operations.listCampaigns();
    return campaigns.map((campaign) => this.toCampaignView(campaign));
  }

  async healthReport(): Promise<{
    readonly application: HealthReport;
    readonly voiceProvider: { readonly status: 'not_integrated'; readonly activeCalls: null };
  }> {
    return {
      application: await this.health.check(),
      voiceProvider: { status: 'not_integrated', activeCalls: null },
    };
  }

  operatorContext(platformRole: PlatformRole | null) {
    return { platformRole };
  }

  async emergencyStop(
    organizationId: string,
    campaignId: string,
    actorUserId: string,
    rawReasonCode: unknown,
  ) {
    if (
      typeof rawReasonCode !== 'string' ||
      !(EMERGENCY_STOP_REASON_CODES as readonly string[]).includes(rawReasonCode)
    ) {
      throw new BadRequestException({
        error: {
          code: 'invalid_emergency_stop_reason_code',
          message: 'Select a supported reason code.',
        },
      });
    }

    const result = await this.operations.emergencyStop({
      organizationId,
      campaignId,
      actorUserId,
      reasonCode: rawReasonCode as (typeof EMERGENCY_STOP_REASON_CODES)[number],
      stoppedAt: new Date(),
    });
    if (result.kind === 'not_found') throw new NotFoundException();
    if (result.kind === 'not_active') {
      throw new ConflictException({
        error: { code: 'campaign_not_active', message: 'Only an active campaign can be stopped.' },
      });
    }
    return {
      ...this.toCampaignView(result.campaign),
      stopResult: result.kind,
      voiceDispatchStopped: false,
    };
  }

  private toCampaignView(campaign: CampaignOperationRecord) {
    return {
      organizationId: campaign.organizationId,
      organizationName: campaign.organizationName,
      organizationSlug: campaign.organizationSlug,
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      emergencyStoppedAt: campaign.emergencyStoppedAt?.toISOString() ?? null,
      updatedAt: campaign.updatedAt.toISOString(),
    };
  }
}
