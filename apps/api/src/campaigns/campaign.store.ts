/**
 * Narrow persistence contract for campaigns.
 *
 * Declared structurally rather than taking a Prisma client, the same reason
 * `auth.store.ts` is: services must be unit-testable without a database, and a
 * consumer gets the queries it needs, not the whole ORM surface.
 *
 * Every method that touches tenant data takes an explicit `organizationId`.
 * There is no method here that can be called without one, so a service cannot
 * accidentally build an unscoped query (AGENTS.md 5).
 */

/**
 * Lifecycle states of a campaign.
 *
 * A string union rather than the generated enum so the contract stays
 * independent of the ORM; `prisma-campaign.store.ts` ties the two together.
 */
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED';

/** Every value {@link CampaignStatus} admits. */
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['DRAFT', 'ACTIVE', 'COMPLETED'];

/** A campaign row as the application sees it. */
export interface CampaignRecord {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly audioAssetId?: string | null;
  readonly emergencyStoppedAt?: Date | null;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What to create a campaign row with. */
export interface NewCampaign {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly createdById: string;
  readonly audioAssetId?: string | null;
}

/** Fields a campaign update may change. Both optional, not both required. */
export interface CampaignChanges {
  readonly name?: string;
  readonly status?: CampaignStatus;
  readonly audioAssetId?: string | null;
}

/** Persistence for tenant-owned campaign rows. */
export interface CampaignStore {
  createCampaign(campaign: NewCampaign): Promise<CampaignRecord>;
  listCampaigns(organizationId: string): Promise<readonly CampaignRecord[]>;
  findCampaign(organizationId: string, campaignId: string): Promise<CampaignRecord | undefined>;
  updateCampaign(
    organizationId: string,
    campaignId: string,
    changes: CampaignChanges,
    actorUserId: string,
  ): Promise<CampaignRecord | undefined>;
  deleteCampaign(organizationId: string, campaignId: string, actorUserId: string): Promise<boolean>;
}
