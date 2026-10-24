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

import { Inject, Injectable } from '@nestjs/common';
import { campaignNotFound, invalidCampaign } from '@truevine/auth';

import {
  CAMPAIGN_STATUSES,
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
}

/** Aggregated read-only report over campaign records for one organization. */
export interface CampaignStatusReport {
  readonly total: number;
  readonly draft: number;
  readonly active: number;
  readonly completed: number;
}

@Injectable()
export class CampaignsService {
  constructor(@Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore) {}

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
  ): Promise<CampaignView> {
    const created = await this.campaigns.createCampaign({
      organizationId,
      id: randomUUID(),
      name: this.validateName(name),
      status: 'DRAFT',
      createdById: actorUserId,
      ...(audioAssetId === undefined
        ? {}
        : { audioAssetId: this.validateAudioAssetId(audioAssetId) }),
    });

    return this.toView(created);
  }

  /** Renames a campaign and/or moves it between `DRAFT`, `ACTIVE` and `COMPLETED`. */
  async update(
    organizationId: string,
    actorUserId: string,
    campaignId: string,
    changes: {
      readonly name?: unknown;
      readonly status?: unknown;
      readonly audioAssetId?: unknown;
    },
  ): Promise<CampaignView> {
    const hasName = changes.name !== undefined;
    const hasStatus = changes.status !== undefined;

    // An empty patch is a client bug, not a no-op worth a 200: accepting it
    // would make a broken form look like it worked.
    const hasAudio = changes.audioAssetId !== undefined;
    if (!hasName && !hasStatus && !hasAudio) {
      throw invalidCampaign('Provide a name or a status to update.');
    }

    const data: { name?: string; status?: CampaignStatus; audioAssetId?: string | null } = {};

    if (hasName) data.name = this.validateName(changes.name);
    if (hasStatus) data.status = this.validateStatus(changes.status);
    if (hasAudio)
      data.audioAssetId =
        changes.audioAssetId === null ? null : this.validateAudioAssetId(changes.audioAssetId);

    const updated = await this.campaigns.updateCampaign(
      organizationId,
      campaignId,
      data,
      actorUserId,
    );

    if (!updated) throw campaignNotFound();

    return this.toView(updated);
  }

  /** Deletes a campaign. */
  async remove(organizationId: string, actorUserId: string, campaignId: string): Promise<void> {
    const deleted = await this.campaigns.deleteCampaign(organizationId, campaignId, actorUserId);

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

  /** Accepts only a status the schema's enum admits. */
  private validateStatus(value: unknown): CampaignStatus {
    if (typeof value !== 'string' || !(CAMPAIGN_STATUSES as readonly string[]).includes(value)) {
      throw invalidCampaign('Unknown campaign status.');
    }

    return value as CampaignStatus;
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
    };
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
