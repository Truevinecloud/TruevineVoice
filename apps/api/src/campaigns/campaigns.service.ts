/**
 * Campaigns under an organization.
 *
 * Every method takes the organization id as an argument and the caller as
 * another. Neither comes from the request body. The guard has already proved the
 * caller holds a membership in that organization and holds the permission being
 * exercised; this service then applies the rules that are about the *content* of
 * the change rather than about reaching it.
 *
 * The repository rechecks membership and permission under an organization lock
 * before mutating, so a revoked membership cannot reuse a guard decision.
 *
 * RBAC-003: `CAMPAIGN_MANAGER` reaches these methods through `campaign:*`
 * permissions; every other role is refused by the guard before this code runs.
 */

import { randomUUID } from 'node:crypto';

import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { campaignNotFound, invalidCampaign } from '@truevine/auth';
import { ContactsService } from '../contacts/contacts.service.js';

import {
  CampaignNotEditableError,
  type CampaignRecord,
  type CampaignStatus,
  type CampaignStore,
} from './campaign.store.js';
import { CAMPAIGN_STORE } from './tokens.js';

/** A campaign as returned to a client. */
export interface CampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus | 'PAUSED';
  readonly emergencyStoppedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly audioAssetId: string | null;
  readonly scheduledAt: string | null;
  readonly retryMaxAttempts: number;
  readonly retryDelayMinutes: number;
  readonly audienceGroupIds: readonly string[];
}

export interface CampaignPreflightIssue {
  readonly code:
    | 'campaign_not_draft'
    | 'audio_required'
    | 'audience_required'
    | 'no_eligible_contacts'
    | 'schedule_required'
    | 'schedule_too_soon'
    | 'schedule_too_far'
    | 'retry_configuration_invalid';
  readonly message: string;
}

export interface CampaignPreflightView {
  readonly campaignId: string;
  readonly valid: boolean;
  readonly checkedAt: string;
  readonly selectedGroupCount: number;
  readonly eligibleContactCount: number;
  readonly issues: readonly CampaignPreflightIssue[];
}

const MAX_AUDIENCE_GROUPS = 20;
const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;
const MAX_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_RETRY_DELAY_MINUTES = 5;
const MAX_RETRY_DELAY_MINUTES = 24 * 60;
const MAX_ATTEMPTS = 5;

/** Aggregated read-only report over campaign records for one organization. */
export interface CampaignStatusReport {
  readonly total: number;
  readonly draft: number;
  readonly active: number;
  readonly completed: number;
}

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(ContactsService) private readonly contacts: ContactsService,
  ) {}

  /** Lists an organization's campaigns. */
  async list(organizationId: string): Promise<readonly CampaignView[]> {
    const campaigns = await this.campaigns.listCampaigns(organizationId);

    return campaigns.map((campaign) => this.toView(campaign));
  }

  /** Summarizes campaign record states without exposing write operations. */
  async statusReport(organizationId: string): Promise<CampaignStatusReport> {
    const campaigns = await this.campaigns.listCampaigns(organizationId);

    return {
      total: campaigns.length,
      draft: campaigns.filter((campaign) => campaign.status === 'DRAFT').length,
      active: campaigns.filter((campaign) => campaign.status === 'ACTIVE').length,
      completed: campaigns.filter((campaign) => campaign.status === 'COMPLETED').length,
    };
  }

  /** Reads one campaign, scoped to the organization. */
  async get(organizationId: string, campaignId: string): Promise<CampaignView> {
    const campaign = await this.campaigns.findCampaign(organizationId, campaignId);

    if (!campaign) throw campaignNotFound();

    return this.toView(campaign);
  }

  /** Creates a campaign in `DRAFT`. Starting it is a separate, deliberate act. */
  async create(
    organizationId: string,
    actorUserId: string,
    name: unknown,
    audioAssetId?: unknown,
    configuration: {
      readonly scheduledAt?: unknown;
      readonly retryMaxAttempts?: unknown;
      readonly retryDelayMinutes?: unknown;
      readonly audienceGroupIds?: unknown;
    } = {},
  ): Promise<CampaignView> {
    const created = await this.campaigns.createCampaign({
      organizationId,
      id: randomUUID(),
      name: this.validateName(name),
      status: 'DRAFT',
      createdById: actorUserId,
      ...(audioAssetId === undefined
        ? {}
        : { audioAssetId: audioAssetId === null ? null : this.validateAudioAssetId(audioAssetId) }),
      scheduledAt: this.validateScheduledAt(configuration.scheduledAt),
      retryMaxAttempts: this.validateMaxAttempts(configuration.retryMaxAttempts ?? 1),
      retryDelayMinutes: this.validateRetryDelay(configuration.retryDelayMinutes ?? 60),
      audienceGroupIds: this.validateGroupIds(configuration.audienceGroupIds ?? []),
    });

    return this.toView(created);
  }

  /** Saves preparation fields on a draft. State changes belong to execution. */
  async update(
    organizationId: string,
    actorUserId: string,
    campaignId: string,
    changes: {
      readonly name?: unknown;
      readonly status?: unknown;
      readonly audioAssetId?: unknown;
      readonly scheduledAt?: unknown;
      readonly retryMaxAttempts?: unknown;
      readonly retryDelayMinutes?: unknown;
      readonly audienceGroupIds?: unknown;
    },
  ): Promise<CampaignView> {
    const hasName = changes.name !== undefined;
    if (changes.status !== undefined) {
      throw invalidCampaign('Campaign state cannot be changed during draft preparation.');
    }

    // An empty patch is a client bug, not a no-op worth a 200: accepting it
    // would make a broken form look like it worked.
    const hasAudio = changes.audioAssetId !== undefined;
    const hasSchedule = changes.scheduledAt !== undefined;
    const hasAttempts = changes.retryMaxAttempts !== undefined;
    const hasRetryDelay = changes.retryDelayMinutes !== undefined;
    const hasGroups = changes.audienceGroupIds !== undefined;
    if (!hasName && !hasAudio && !hasSchedule && !hasAttempts && !hasRetryDelay && !hasGroups)
      throw invalidCampaign('Provide at least one draft field to update.');

    const data: {
      name?: string;
      audioAssetId?: string | null;
      scheduledAt?: Date | null;
      retryMaxAttempts?: number;
      retryDelayMinutes?: number;
      audienceGroupIds?: readonly string[];
    } = {};

    if (hasName) data.name = this.validateName(changes.name);
    if (hasAudio)
      data.audioAssetId =
        changes.audioAssetId === null ? null : this.validateAudioAssetId(changes.audioAssetId);
    if (hasSchedule) data.scheduledAt = this.validateScheduledAt(changes.scheduledAt);
    if (hasAttempts) data.retryMaxAttempts = this.validateMaxAttempts(changes.retryMaxAttempts);
    if (hasRetryDelay) data.retryDelayMinutes = this.validateRetryDelay(changes.retryDelayMinutes);
    if (hasGroups) data.audienceGroupIds = this.validateGroupIds(changes.audienceGroupIds);

    let updated: CampaignRecord | undefined;
    try {
      updated = await this.campaigns.updateCampaign(organizationId, campaignId, data, actorUserId);
    } catch (error) {
      if (error instanceof CampaignNotEditableError) {
        throw new ConflictException({
          error: { code: 'campaign_not_editable', message: 'Only draft campaigns can be edited.' },
        });
      }
      throw error;
    }

    if (!updated) throw campaignNotFound();

    return this.toView(updated);
  }

  /** Validates draft readiness without creating recipients, executions, or jobs. */
  async preflight(organizationId: string, campaignId: string): Promise<CampaignPreflightView> {
    const campaign = await this.campaigns.findCampaign(organizationId, campaignId);
    if (!campaign) throw campaignNotFound();

    const now = new Date();
    const groupIds = campaign.audienceGroupIds ?? [];
    const eligibleContactCount = groupIds.length
      ? await this.contacts.countEligibleForCampaign(organizationId, groupIds)
      : 0;
    const issues: CampaignPreflightIssue[] = [];

    if (campaign.status !== 'DRAFT' || campaign.emergencyStoppedAt) {
      issues.push({
        code: 'campaign_not_draft',
        message: 'Only an unstopped draft can pass preparation preflight.',
      });
    }
    if (!campaign.audioAssetId) {
      issues.push({ code: 'audio_required', message: 'Select a message audio asset.' });
    }
    if (groupIds.length === 0 || groupIds.length > MAX_AUDIENCE_GROUPS) {
      issues.push({
        code: 'audience_required',
        message: `Select between 1 and ${MAX_AUDIENCE_GROUPS} contact groups.`,
      });
    } else if (eligibleContactCount === 0) {
      issues.push({
        code: 'no_eligible_contacts',
        message: 'The selected groups currently contain no consented, unsuppressed contacts.',
      });
    }
    const scheduleIssue = this.scheduleIssue(campaign.scheduledAt ?? null, now);
    if (scheduleIssue) issues.push(scheduleIssue);
    if (!this.validRetryConfiguration(campaign.retryMaxAttempts, campaign.retryDelayMinutes)) {
      issues.push({
        code: 'retry_configuration_invalid',
        message: 'Retry attempts must be 1–5 and retry delay must be 5–1440 minutes.',
      });
    }

    return {
      campaignId,
      valid: issues.length === 0,
      checkedAt: now.toISOString(),
      selectedGroupCount: groupIds.length,
      eligibleContactCount,
      issues,
    };
  }

  /** Deletes a campaign. */
  async remove(organizationId: string, actorUserId: string, campaignId: string): Promise<void> {
    let deleted: boolean;
    try {
      deleted = await this.campaigns.deleteCampaign(organizationId, campaignId, actorUserId);
    } catch (error) {
      if (error instanceof CampaignNotEditableError) {
        throw new ConflictException({
          error: { code: 'campaign_not_editable', message: 'Only draft campaigns can be deleted.' },
        });
      }
      throw error;
    }

    if (!deleted) throw campaignNotFound();
  }

  /** Trims and bounds a campaign name. Never echoes the offending value. */
  private validateName(value: unknown): string {
    if (typeof value !== 'string') throw invalidCampaign('Campaign name must be text.');

    const trimmed = value.trim();

    if (trimmed.length === 0 || trimmed.length > 200) {
      throw invalidCampaign('Campaign name must be 1 to 200 characters.');
    }

    return trimmed;
  }

  private toView(campaign: CampaignRecord): CampaignView {
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.emergencyStoppedAt ? 'PAUSED' : campaign.status,
      emergencyStoppedAt: campaign.emergencyStoppedAt?.toISOString() ?? null,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
      audioAssetId: campaign.audioAssetId ?? null,
      scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
      retryMaxAttempts: campaign.retryMaxAttempts ?? 1,
      retryDelayMinutes: campaign.retryDelayMinutes ?? 60,
      audienceGroupIds: campaign.audienceGroupIds ?? [],
    };
  }

  private validateScheduledAt(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ) {
      throw invalidCampaign('Schedule time must be an ISO-8601 timestamp with a timezone.');
    }
    const date = new Date(value);
    const issue = this.scheduleIssue(date, new Date());
    if (issue) throw invalidCampaign(issue.message);
    return date;
  }

  private scheduleIssue(value: Date | null, now: Date): CampaignPreflightIssue | undefined {
    if (!value) return { code: 'schedule_required', message: 'Choose a future schedule time.' };
    const time = value.getTime();
    if (!Number.isFinite(time) || time < now.getTime() + MIN_SCHEDULE_LEAD_MS) {
      return {
        code: 'schedule_too_soon',
        message: 'Schedule the campaign at least 5 minutes ahead.',
      };
    }
    if (time > now.getTime() + MAX_SCHEDULE_HORIZON_MS) {
      return {
        code: 'schedule_too_far',
        message: 'Schedule the campaign within the next 365 days.',
      };
    }
    return undefined;
  }

  private validateMaxAttempts(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_ATTEMPTS
    ) {
      throw invalidCampaign(
        'Retry attempts must be an integer from 1 to 5, including the first attempt.',
      );
    }
    return value;
  }

  private validateRetryDelay(value: unknown): number {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_RETRY_DELAY_MINUTES ||
      value > MAX_RETRY_DELAY_MINUTES
    ) {
      throw invalidCampaign('Retry delay must be an integer from 5 to 1440 minutes.');
    }
    return value;
  }

  private validRetryConfiguration(attempts?: number, delay?: number): boolean {
    return (
      typeof attempts === 'number' &&
      Number.isInteger(attempts) &&
      attempts >= 1 &&
      attempts <= MAX_ATTEMPTS &&
      typeof delay === 'number' &&
      Number.isInteger(delay) &&
      delay >= MIN_RETRY_DELAY_MINUTES &&
      delay <= MAX_RETRY_DELAY_MINUTES
    );
  }

  private validateGroupIds(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length > MAX_AUDIENCE_GROUPS) {
      throw invalidCampaign(
        `Audience must contain no more than ${MAX_AUDIENCE_GROUPS} contact groups.`,
      );
    }
    const ids = value.map((id: unknown) => {
      if (
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ) {
        throw invalidCampaign('Choose valid contact groups.');
      }
      return id.toLowerCase();
    });
    if (new Set(ids).size !== ids.length)
      throw invalidCampaign('Contact groups must not be selected twice.');
    return ids;
  }

  private validateAudioAssetId(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ) {
      throw invalidCampaign('Choose a valid audio asset.');
    }
    return value;
  }
}
