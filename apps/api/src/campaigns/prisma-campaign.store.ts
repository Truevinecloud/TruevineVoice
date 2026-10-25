import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@truevine/database';
import { invalidCampaign } from '@truevine/auth';

import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';
import {
  campaignAuditState,
  mutationRefused,
  writeMutationAudit,
} from '../auth/sensitive-audit.js';
import { DATABASE_CLIENT } from '../tokens.js';
import {
  CampaignNotEditableError,
  type CampaignChanges,
  type CampaignRecord,
  type CampaignStore,
  type NewCampaign,
} from './campaign.store.js';

const audienceInclude = {
  audienceGroups: { select: { groupId: true } },
} satisfies Prisma.CampaignInclude;
type CampaignRow = Prisma.CampaignGetPayload<{ include: typeof audienceInclude }>;

type CampaignClient = Pick<
  PrismaClient,
  | 'campaign'
  | 'campaignAudienceGroup'
  | 'contactGroup'
  | 'audioAssetUsage'
  | 'audioAsset'
  | 'securityAuditEvent'
> &
  TenantWriteSql;
type CampaignDatabase = CampaignClient & {
  $transaction<T>(work: (tx: CampaignClient) => Promise<T>): Promise<T>;
};

function toRecord(row: CampaignRow): CampaignRecord {
  return {
    organizationId: row.organizationId,
    id: row.id,
    name: row.name,
    status: row.status,
    audioAssetId: row.audioAssetId,
    scheduledAt: row.scheduledAt,
    retryMaxAttempts: row.retryMaxAttempts,
    retryDelayMinutes: row.retryDelayMinutes,
    audienceGroupIds: row.audienceGroups.map(({ groupId }) => groupId),
    emergencyStoppedAt: row.emergencyStoppedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertTenantGroups(
  tx: CampaignClient,
  organizationId: string,
  groupIds: readonly string[],
): Promise<void> {
  if (groupIds.length === 0) return;
  const groups = await tx.contactGroup.findMany({
    where: { organizationId, id: { in: [...groupIds] } },
    select: { id: true },
  });
  if (groups.length !== groupIds.length) {
    throw invalidCampaign(
      'One or more selected contact groups were not found in this organization.',
    );
  }
}

/** Scoped mutations, fresh authority, persistence, and audit share a transaction. */
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
        await assertTenantGroups(tx, campaign.organizationId, campaign.audienceGroupIds ?? []);
        if (campaign.audioAssetId) {
          const asset = await tx.audioAsset.findUnique({
            where: {
              organizationId_id: {
                organizationId: campaign.organizationId,
                id: campaign.audioAssetId,
              },
            },
            select: { id: true },
          });
          if (!asset)
            throw invalidCampaign('Selected audio asset was not found in this organization.');
        }
        await tx.campaign.create({
          data: {
            organizationId: campaign.organizationId,
            id: campaign.id,
            name: campaign.name,
            status: 'DRAFT',
            audioOrganizationId: campaign.audioAssetId ? campaign.organizationId : null,
            audioAssetId: campaign.audioAssetId ?? null,
            scheduledAt: campaign.scheduledAt ?? null,
            retryMaxAttempts: campaign.retryMaxAttempts ?? 1,
            retryDelayMinutes: campaign.retryDelayMinutes ?? 60,
            createdById: campaign.createdById,
          },
        });
        const groupIds = campaign.audienceGroupIds ?? [];
        if (groupIds.length > 0) {
          await tx.campaignAudienceGroup.createMany({
            data: groupIds.map((groupId) => ({
              organizationId: campaign.organizationId,
              campaignId: campaign.id,
              groupId,
            })),
          });
        }
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
              campaignId: campaign.id,
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
            targetId: campaign.id,
            before: null,
            change: { audioSelected: true },
            after: { audioSelected: true },
            reasonCode: 'campaign_audio_selected',
          });
        }
        const row = await tx.campaign.findUniqueOrThrow({
          where: {
            organizationId_id: { organizationId: campaign.organizationId, id: campaign.id },
          },
          include: audienceInclude,
        });
        const view = toRecord(row);
        await writeMutationAudit(tx, {
          organizationId: campaign.organizationId,
          actorUserId: campaign.createdById,
          action: 'campaign.created',
          targetType: 'campaign',
          targetId: campaign.id,
          before: null,
          change: campaignAuditState(view),
          after: campaignAuditState(view),
          reasonCode: 'campaign_creation',
          legacy: { organizationId: campaign.organizationId, campaignId: campaign.id },
        });
        return view;
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

  async listCampaigns(organizationId: string): Promise<readonly CampaignRecord[]> {
    const rows = await this.prisma.campaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: audienceInclude,
    });
    return rows.map(toRecord);
  }

  async findCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignRecord | undefined> {
    const row = await this.prisma.campaign.findUnique({
      where: { organizationId_id: { organizationId, id: campaignId } },
      include: audienceInclude,
    });
    return row ? toRecord(row) : undefined;
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
        const beforeRow = await tx.campaign.findUnique({
          where: { organizationId_id: { organizationId, id: campaignId } },
          include: audienceInclude,
        });
        if (!beforeRow) return undefined;
        if (beforeRow.status !== 'DRAFT' || beforeRow.emergencyStoppedAt) {
          throw new CampaignNotEditableError();
        }
        const before = toRecord(beforeRow);
        const beforeState = campaignAuditState(before);
        const data = {
          updatedAt: new Date(),
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.scheduledAt === undefined ? {} : { scheduledAt: changes.scheduledAt }),
          ...(changes.retryMaxAttempts === undefined
            ? {}
            : { retryMaxAttempts: changes.retryMaxAttempts }),
          ...(changes.retryDelayMinutes === undefined
            ? {}
            : { retryDelayMinutes: changes.retryDelayMinutes }),
          ...(Object.hasOwn(changes, 'audioAssetId')
            ? {
                audioOrganizationId: changes.audioAssetId ? organizationId : null,
                audioAssetId: changes.audioAssetId ?? null,
              }
            : {}),
        };
        if (Object.hasOwn(changes, 'audienceGroupIds')) {
          const groupIds = changes.audienceGroupIds ?? [];
          await assertTenantGroups(tx, organizationId, groupIds);
          await tx.campaignAudienceGroup.deleteMany({ where: { organizationId, campaignId } });
          if (groupIds.length > 0) {
            await tx.campaignAudienceGroup.createMany({
              data: groupIds.map((groupId) => ({ organizationId, campaignId, groupId })),
            });
          }
        }
        if (changes.audioAssetId) {
          const asset = await tx.audioAsset.findUnique({
            where: { organizationId_id: { organizationId, id: changes.audioAssetId } },
            select: { id: true },
          });
          if (!asset)
            throw invalidCampaign('Selected audio asset was not found in this organization.');
        }
        const result = await tx.campaign.updateMany({
          where: { organizationId, id: campaignId, status: 'DRAFT', emergencyStoppedAt: null },
          data,
        });
        if (result.count !== 1) throw new CampaignNotEditableError();
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
        const afterRow = await tx.campaign.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: campaignId } },
          include: audienceInclude,
        });
        const after = toRecord(afterRow);
        await writeMutationAudit(tx, {
          organizationId,
          actorUserId,
          action: 'campaign.updated',
          targetType: 'campaign',
          targetId: campaignId,
          before: beforeState,
          change: {
            fields: [
              ...Object.keys(data),
              ...(Object.hasOwn(changes, 'audienceGroupIds') ? ['audienceGroupIds'] : []),
            ],
          },
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
            organizationId,
            actorUserId,
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
        const beforeRow = await tx.campaign.findUnique({
          where: { organizationId_id: { organizationId, id: campaignId } },
          include: audienceInclude,
        });
        if (!beforeRow) return false;
        if (beforeRow.status !== 'DRAFT' || beforeRow.emergencyStoppedAt) {
          throw new CampaignNotEditableError();
        }
        const before = toRecord(beforeRow);
        const result = await tx.campaign.deleteMany({
          where: { organizationId, id: campaignId, status: 'DRAFT', emergencyStoppedAt: null },
        });
        if (result.count !== 1) throw new CampaignNotEditableError();
        await writeMutationAudit(tx, {
          organizationId,
          actorUserId,
          action: 'campaign.deleted',
          targetType: 'campaign',
          targetId: campaignId,
          before: campaignAuditState(before),
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
            organizationId,
            actorUserId,
            action: 'campaign.deleted',
            targetType: 'campaign',
            targetId: campaignId,
          },
          error,
        ),
      );
  }
}
