import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import { DATABASE_CLIENT } from '../tokens.js';
import type {
  CampaignOperationRecord,
  EmergencyStopInput,
  EmergencyStopResult,
  OperationsStore,
} from './operations.store.js';

type OperationsClient = Pick<PrismaClient, 'organization' | 'campaign' | 'securityAuditEvent'>;
type OperationsDatabase = OperationsClient & {
  $transaction<T>(work: (tx: OperationsClient) => Promise<T>): Promise<T>;
};

@Injectable()
export class PrismaOperationsStore implements OperationsStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: OperationsDatabase) {}

  async listOrganizations() {
    const organizations = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        suspendedAt: true,
        createdAt: true,
        _count: { select: { campaigns: true } },
      },
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.suspendedAt ? ('SUSPENDED' as const) : ('ACTIVE' as const),
      createdAt: organization.createdAt,
      campaignCount: organization._count.campaigns,
    }));
  }

  async listCampaigns(): Promise<readonly CampaignOperationRecord[]> {
    const campaigns = await this.prisma.campaign.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: {
        organizationId: true,
        id: true,
        name: true,
        status: true,
        emergencyStoppedAt: true,
        updatedAt: true,
        organization: { select: { name: true, slug: true } },
      },
    });

    return campaigns.map((campaign) => ({
      organizationId: campaign.organizationId,
      organizationName: campaign.organization.name,
      organizationSlug: campaign.organization.slug,
      id: campaign.id,
      name: campaign.name,
      status: campaign.emergencyStoppedAt ? 'PAUSED' : campaign.status,
      emergencyStoppedAt: campaign.emergencyStoppedAt,
      updatedAt: campaign.updatedAt,
    }));
  }

  async emergencyStop(input: EmergencyStopInput): Promise<EmergencyStopResult> {
    assertKnownAuditAction('platform.campaign.emergency_stopped');
    const metadata = { reasonCode: input.reasonCode };
    if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe emergency-stop audit metadata.');

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.campaign.updateMany({
        where: {
          organizationId: input.organizationId,
          id: input.campaignId,
          status: 'ACTIVE',
          emergencyStoppedAt: null,
        },
        data: { status: 'COMPLETED', emergencyStoppedAt: input.stoppedAt },
      });

      if (result.count !== 1) {
        const existing = await tx.campaign.findUnique({
          where: {
            organizationId_id: {
              organizationId: input.organizationId,
              id: input.campaignId,
            },
          },
          select: {
            organizationId: true,
            id: true,
            name: true,
            status: true,
            emergencyStoppedAt: true,
            updatedAt: true,
            organization: { select: { name: true, slug: true } },
          },
        });
        if (!existing) return { kind: 'not_found' };
        const campaign = this.toCampaignRecord(existing);
        return existing.emergencyStoppedAt
          ? { kind: 'already_stopped', campaign }
          : { kind: 'not_active' };
      }

      await tx.securityAuditEvent.create({
        data: {
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: 'platform.campaign.emergency_stopped',
          scope: 'PLATFORM',
          outcome: 'SUCCESS',
          targetType: 'campaign',
          targetId: input.campaignId,
          metadata,
        },
      });

      const stopped = await tx.campaign.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: input.organizationId,
            id: input.campaignId,
          },
        },
        select: {
          organizationId: true,
          id: true,
          name: true,
          status: true,
          emergencyStoppedAt: true,
          updatedAt: true,
          organization: { select: { name: true, slug: true } },
        },
      });

      return { kind: 'stopped', campaign: this.toCampaignRecord(stopped) };
    });
  }

  private toCampaignRecord(campaign: {
    organizationId: string;
    id: string;
    name: string;
    status: 'DRAFT' | 'ACTIVE' | 'COMPLETED';
    emergencyStoppedAt: Date | null;
    updatedAt: Date;
    organization: { name: string; slug: string };
  }): CampaignOperationRecord {
    return {
      organizationId: campaign.organizationId,
      organizationName: campaign.organization.name,
      organizationSlug: campaign.organization.slug,
      id: campaign.id,
      name: campaign.name,
      status: campaign.emergencyStoppedAt ? 'PAUSED' : campaign.status,
      emergencyStoppedAt: campaign.emergencyStoppedAt,
      updatedAt: campaign.updatedAt,
    };
  }
}
