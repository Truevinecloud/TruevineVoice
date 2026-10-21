/**
 * Prisma implementation of the campaign persistence contract.
 *
 * This is the only file that knows both the ORM and the campaign storage
 * contract. Services depend on the interface, so a unit test injects a fake and
 * never loads a database; an end-to-end test injects this and exercises real
 * PostgreSQL constraints.
 *
 * Every tenant-owned query names its organization: there is no method here that
 * can read or write a campaign row without an `organizationId` argument
 * (AGENTS.md 5).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';
import { DATABASE_CLIENT } from '../tokens.js';
import type {
  CampaignChanges,
  CampaignRecord,
  CampaignStore,
  NewCampaign,
} from './campaign.store.js';

/** The slice of the Prisma client this store needs. */
type CampaignClient = Pick<PrismaClient, 'campaign'> & TenantWriteSql;
type CampaignDatabase = CampaignClient & {
  $transaction<T>(work: (tx: CampaignClient) => Promise<T>): Promise<T>;
};

@Injectable()
export class PrismaCampaignStore implements CampaignStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: CampaignDatabase) {}

  async createCampaign(campaign: NewCampaign): Promise<CampaignRecord> {
    return this.prisma.$transaction(async (tx) => {
      await authorizeTenantWrite(
        tx,
        campaign.organizationId,
        campaign.createdById,
        'campaign:create',
      );
      return tx.campaign.create({
        data: {
          organizationId: campaign.organizationId,
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          createdById: campaign.createdById,
        },
      });
    });
  }

  async listCampaigns(organizationId: string): Promise<readonly CampaignRecord[]> {
    return this.prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignRecord | undefined> {
    return (
      (await this.prisma.campaign.findUnique({
        where: { organizationId_id: { organizationId, id: campaignId } },
      })) ?? undefined
    );
  }

  async updateCampaign(
    organizationId: string,
    campaignId: string,
    changes: CampaignChanges,
    actorUserId: string,
  ): Promise<CampaignRecord | undefined> {
    // `updateMany` rather than `update`: it returns a count instead of throwing
    // on a miss, which lets a campaign belonging to another tenant be reported
    // as not found - the same answer as a genuinely unknown id, which is the
    // point (an id from another tenant is not a privilege, just an id).
    return this.prisma.$transaction(async (tx) => {
      await authorizeTenantWrite(tx, organizationId, actorUserId, 'campaign:update');
      const result = await tx.campaign.updateMany({
        where: {
          organizationId,
          id: campaignId,
          ...(changes.status === 'ACTIVE' ? { emergencyStoppedAt: null } : {}),
        },
        data: changes,
      });

      if (result.count !== 1) return undefined;

      return (
        (await tx.campaign.findUnique({
          where: { organizationId_id: { organizationId, id: campaignId } },
        })) ?? undefined
      );
    });
  }

  async deleteCampaign(
    organizationId: string,
    campaignId: string,
    actorUserId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await authorizeTenantWrite(tx, organizationId, actorUserId, 'campaign:delete');
      const result = await tx.campaign.deleteMany({
        where: { organizationId, id: campaignId, emergencyStoppedAt: null },
      });

      return result.count === 1;
    });
  }
}
