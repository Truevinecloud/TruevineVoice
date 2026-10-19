/**
 * Campaigns under an organization.
 *
 * Every method takes the organization id as an argument and the caller as
 * another. Neither comes from the request body. The guard has already proved the
 * caller holds a membership in that organization and holds the permission being
 * exercised; this service then applies the rules that are about the *content* of
 * the change rather than about reaching it.
 *
 * No `SecurityTransaction` here, unlike the ownership-sensitive paths in
 * `OrganizationsService`: a campaign mutation is a single row write, and the
 * organization scope is carried in the write itself. The transaction seam is
 * reserved for operations that must re-check a security invariant after a lock
 * (role change, removal, ownership transfer) - none of which a campaign is.
 *
 * RBAC-003: `CAMPAIGN_MANAGER` reaches these methods through `campaign:*`
 * permissions; every other role is refused by the guard before this code runs.
 */

import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  assertKnownAuditAction,
  campaignNotFound,
  invalidCampaign,
  isSafeAuditMetadata,
} from '@truevine/auth';

import type { AuditStore } from '../auth/auth.store.js';
import { AUDIT_STORE } from '../auth/tokens.js';

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
  readonly status: CampaignStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(AUDIT_STORE) private readonly auditStore: AuditStore,
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
  async create(organizationId: string, actorUserId: string, name: unknown): Promise<CampaignView> {
    const created = await this.campaigns.createCampaign({
      organizationId,
      id: randomUUID(),
      name: this.validateName(name),
      status: 'DRAFT',
      createdById: actorUserId,
    });

    await this.audit(organizationId, actorUserId, 'campaign.created', 'SUCCESS', {
      organizationId,
      campaignId: created.id,
    });

    return this.toView(created);
  }

  /** Renames a campaign and/or moves it between `DRAFT`, `ACTIVE` and `COMPLETED`. */
  async update(
    organizationId: string,
    actorUserId: string,
    campaignId: string,
    changes: { readonly name?: unknown; readonly status?: unknown },
  ): Promise<CampaignView> {
    const hasName = changes.name !== undefined;
    const hasStatus = changes.status !== undefined;

    // An empty patch is a client bug, not a no-op worth a 200: accepting it
    // would make a broken form look like it worked.
    if (!hasName && !hasStatus) {
      throw invalidCampaign('Provide a name or a status to update.');
    }

    const data: { name?: string; status?: CampaignStatus } = {};

    if (hasName) data.name = this.validateName(changes.name);
    if (hasStatus) data.status = this.validateStatus(changes.status);

    const updated = await this.campaigns.updateCampaign(organizationId, campaignId, data);

    if (!updated) throw campaignNotFound();

    await this.audit(organizationId, actorUserId, 'campaign.updated', 'SUCCESS', {
      organizationId,
      campaignId,
    });

    return this.toView(updated);
  }

  /** Deletes a campaign. */
  async remove(organizationId: string, actorUserId: string, campaignId: string): Promise<void> {
    const deleted = await this.campaigns.deleteCampaign(organizationId, campaignId);

    if (!deleted) throw campaignNotFound();

    await this.audit(organizationId, actorUserId, 'campaign.deleted', 'SUCCESS', {
      organizationId,
      campaignId,
    });
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
      status: campaign.status,
      createdAt: campaign.createdAt.toISOString(),
      updatedAt: campaign.updatedAt.toISOString(),
    };
  }

  private async audit(
    organizationId: string,
    actorUserId: string,
    action: string,
    outcome: 'SUCCESS' | 'DENIED',
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    assertKnownAuditAction(action);

    if (!isSafeAuditMetadata(metadata)) {
      throw new Error('Refusing to write audit metadata containing a credential-shaped key.');
    }

    await this.auditStore.record({
      organizationId,
      actorUserId,
      action,
      scope: 'ORGANIZATION',
      outcome,
      metadata,
    });
  }
}
