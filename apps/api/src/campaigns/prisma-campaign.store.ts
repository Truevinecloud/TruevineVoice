import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';
import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';
import { invalidCampaign } from '@truevine/auth';
import {
  campaignAuditState,
  writeMutationAudit,
  mutationRefused,
} from '../auth/sensitive-audit.js';
import { DATABASE_CLIENT } from '../tokens.js';
import type {
  CampaignChanges,
  CampaignRecord,
  CampaignStore,
  NewCampaign,
} from './campaign.store.js';

type CampaignClient = Pick<
  PrismaClient,
  'campaign' | 'audioAssetUsage' | 'audioAsset' | 'securityAuditEvent'
> &
  TenantWriteSql;
type CampaignDatabase = CampaignClient & {
  $transaction<T>(work: (tx: CampaignClient) => Promise<T>): Promise<T>;
};
/** Scoped mutation, fresh authority and required audit share one transaction. */
@Injectable()
export class PrismaCampaignStore implements CampaignStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: CampaignDatabase) {}
  async createCampaign(campaign: NewCampaign): Promise<CampaignRecord> {
    return this.prisma
      .$transaction(async (tx) => {
        await authorizeTenantWrite(
          tx,
          campaign.organizationId,
          campaign.createdById,
          'campaign:create',
        );
        const created = await tx.campaign.create({
          data: {
            ...campaign,
            audioOrganizationId: campaign.audioAssetId ? campaign.organizationId : null,
          },
        });
        if (campaign.audioAssetId) {
          const asset = await tx.audioAsset.findUnique({
            where: {
              organizationId_id: {
                organizationId: campaign.organizationId,
                id: campaign.audioAssetId,
              },
            },
          });
          if (!asset)
            throw invalidCampaign('Selected audio asset was not found in this organization.');
          await tx.audioAssetUsage.create({
            data: {
              organizationId: campaign.organizationId,
              assetId: asset.id,
              actorUserId: campaign.createdById,
              action: 'CAMPAIGN_SELECTED',
              campaignId: created.id,
              byteSize: asset.byteSize,
              durationMs: asset.durationMs,
              ttsCharacterCount: asset.ttsCharacterCount,
            },
          });
          await writeMutationAudit(tx, {
            organizationId: campaign.organizationId,
            actorUserId: campaign.createdById,
            action: 'campaign.audio_selected',
            targetType: 'campaign',
            targetId: created.id,
            before: null,
            change: { audioSelected: true },
            after: { audioSelected: true },
            reasonCode: 'campaign_audio_selected',
          });
        }
        await writeMutationAudit(tx, {
          organizationId: campaign.organizationId,
          actorUserId: campaign.createdById,
          action: 'campaign.created',
          targetType: 'campaign',
          targetId: created.id,
          before: null,
          change: campaignAuditState(created),
          after: campaignAuditState(created),
          reasonCode: 'campaign_creation',
          legacy: { organizationId: campaign.organizationId, campaignId: created.id },
        });
        return created;
      })
      .catch((error) =>
        mutationRefused(
          this.prisma,
          {
            organizationId: campaign.organizationId,
            actorUserId: campaign.createdById,
            action: 'campaign.created',
            targetType: 'campaign',
            targetId: campaign.id,
          },
          error,
        ),
      );
  }
  listCampaigns(organizationId: string): Promise<readonly CampaignRecord[]> {
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
    return this.prisma
      .$transaction(async (tx) => {
        await authorizeTenantWrite(tx, organizationId, actorUserId, 'campaign:update');
        const before = await tx.campaign.findUnique({
          where: { organizationId_id: { organizationId, id: campaignId } },
        });
        if (!before) return undefined;
        const beforeState = campaignAuditState(before);
        // Project mutable fields explicitly; organization/creator identity cannot move.
        const data = {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          ...(Object.hasOwn(changes, 'audioAssetId')
            ? { audioOrganizationId: changes.audioAssetId ? organizationId : null }
            : {}),
        };
        const result = await tx.campaign.updateMany({
          where: {
            organizationId,
            id: campaignId,
            ...(changes.status === 'ACTIVE' ? { emergencyStoppedAt: null } : {}),
          },
          data,
        });
        if (result.count !== 1) return undefined;
        if (Object.hasOwn(changes, 'audioAssetId')) {
          if (changes.audioAssetId) {
            const asset = await tx.audioAsset.findUnique({
              where: { organizationId_id: { organizationId, id: changes.audioAssetId } },
            });
            if (!asset)
              throw invalidCampaign('Selected audio asset was not found in this organization.');
            await tx.audioAssetUsage.create({
              data: {
                organizationId,
                assetId: asset.id,
                actorUserId,
                action: 'CAMPAIGN_SELECTED',
                campaignId,
                byteSize: asset.byteSize,
                durationMs: asset.durationMs,
                ttsCharacterCount: asset.ttsCharacterCount,
              },
            });
          }
          await writeMutationAudit(tx, {
            organizationId,
            actorUserId,
            action: 'campaign.audio_selected',
            targetType: 'campaign',
            targetId: campaignId,
            before: { audioSelected: before.audioAssetId !== null },
            change: { audioSelected: changes.audioAssetId !== null },
            after: { audioSelected: changes.audioAssetId !== null },
            reasonCode: 'campaign_audio_selected',
          });
        }
        const after = await tx.campaign.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: campaignId } },
        });
        await writeMutationAudit(tx, {
          organizationId,
          actorUserId,
          action: 'campaign.updated',
          targetType: 'campaign',
          targetId: campaignId,
          before: beforeState,
          change: { fields: Object.keys(data) },
          after: campaignAuditState(after),
          reasonCode: 'campaign_update',
          legacy: { organizationId, campaignId },
        });
        return after;
      })
      .catch((error) =>
        mutationRefused(
          this.prisma,
          {
            organizationId: organizationId,
            actorUserId: actorUserId,
            action: 'campaign.updated',
            targetType: 'campaign',
            targetId: campaignId,
          },
          error,
        ),
      );
  }
  async deleteCampaign(
    organizationId: string,
    campaignId: string,
    actorUserId: string,
  ): Promise<boolean> {
    return this.prisma
      .$transaction(async (tx) => {
        await authorizeTenantWrite(tx, organizationId, actorUserId, 'campaign:delete');
        const before = await tx.campaign.findUnique({
          where: { organizationId_id: { organizationId, id: campaignId } },
        });
        if (!before) return false;
        const beforeState = campaignAuditState(before);
        const result = await tx.campaign.deleteMany({
          where: { organizationId, id: campaignId, emergencyStoppedAt: null },
        });
        if (result.count !== 1) return false;
        await writeMutationAudit(tx, {
          organizationId,
          actorUserId,
          action: 'campaign.deleted',
          targetType: 'campaign',
          targetId: campaignId,
          before: beforeState,
          change: { deleted: true },
          after: null,
          reasonCode: 'campaign_deletion',
          legacy: { organizationId, campaignId },
        });
        return true;
      })
      .catch((error) =>
        mutationRefused(
          this.prisma,
          {
            organizationId: organizationId,
            actorUserId: actorUserId,
            action: 'campaign.deleted',
            targetType: 'campaign',
            targetId: campaignId,
          },
          error,
        ),
      );
  }
}
