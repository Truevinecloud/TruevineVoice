/**
 * SMS fallback trigger route.
 *
 * `POST /organizations/:organizationId/campaigns/:campaignId/sms-fallback`
 * initiates an idempotent SMS fallback for an eligible failed voice call.
 *
 * All route parameters come from the path. The organization guard has already
 * proved the caller holds a membership in that organization. The voice attempt
 * id is taken from the request body; every other eligibility input (recipient
 * identity, destination phone, approved message, entitlement, consent,
 * suppression, billing, provider readiness, voice outcome) is derived
 * exclusively from trusted server-side database records by the orchestration
 * service. The caller cannot supply or override any of these values.
 */

import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CsrfGuard } from '../auth/csrf.guard.js';
import { OrganizationGuard } from '../auth/organization.guard.js';
import {
  CurrentOrganization,
  RequireAcceptedTerms,
  RequireOrganizationPermission,
} from '../auth/permission.decorators.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DATABASE_CLIENT } from '../tokens.js';

import { SmsFallbackOrchestrationService } from './sms-fallback-orchestration.service.js';

const Protected = [SessionGuard, OrganizationGuard, CsrfGuard];

@Controller()
export class SmsFallbackController {
  constructor(
    @Inject(SmsFallbackOrchestrationService)
    private readonly fallback: SmsFallbackOrchestrationService,
    @Inject(DATABASE_CLIENT) private readonly db: { $queryRaw<T = unknown>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T[]> },
  ) {}

  /** `POST /organizations/:organizationId/campaigns/:campaignId/sms-fallback` */
  @Post('organizations/:organizationId/campaigns/:campaignId/sms-fallback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(...Protected)
  @RequireAcceptedTerms()
  @RequireOrganizationPermission('campaign:update')
  async triggerFallback(
    @CurrentOrganization() context: { organizationId: string },
    @Param('campaignId') campaignId: string,
    @Body()
    body: {
      readonly voiceAttemptId?: unknown;
    },
  ) {
    const { organizationId } = context;

    const voiceAttemptId = body.voiceAttemptId;

    if (typeof voiceAttemptId !== 'string' || voiceAttemptId.length === 0) {
      throw new ForbiddenException({
        error: {
          code: 'sms_fallback_invalid_request',
          message: 'voiceAttemptId is required.',
        },
      });
    }

    // Validate campaign ownership: the campaign must exist in this organization.
    const campaigns = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM campaigns
      WHERE organization_id = ${organizationId}::uuid AND id = ${campaignId}::uuid`;
    if (!campaigns[0]) {
      throw new NotFoundException({
        error: {
          code: 'campaign_not_found',
          message: 'Campaign not found in this organization.',
        },
      });
    }

    // Validate that the voice attempt belongs to this organization and campaign.
    const attempts = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM call_attempts
      WHERE organization_id = ${organizationId}::uuid
        AND campaign_id = ${campaignId}::uuid
        AND id = ${voiceAttemptId}::uuid`;
    if (!attempts[0]) {
      throw new NotFoundException({
        error: {
          code: 'voice_attempt_not_found',
          message: 'Voice attempt not found in this campaign.',
        },
      });
    }

    // All sensitive eligibility inputs are derived from server-side records
    // by the orchestration service. The caller supplies only the voice attempt id.
    const result = await this.fallback.evaluateAndDispatch({
      organizationId,
      campaignId,
      voiceAttemptId,
    });

    return result;
  }
}
