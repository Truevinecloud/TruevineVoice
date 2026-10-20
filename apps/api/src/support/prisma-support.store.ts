import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import type {
  OrganizationDiagnosticsRecord,
  SupportAuditEventRecord,
  SupportAuditTrailInput,
  SupportMemberRecord,
  SupportMembershipRecord,
  SupportOrganizationDetail,
  SupportOrganizationSearchInput,
  SupportOrganizationSummary,
  SupportSessionSummary,
  SupportStore,
  SupportUserDetail,
  SupportUserSearchInput,
  SupportUserSummary,
} from './support.store.js';

type SupportClient = Pick<
  PrismaClient,
  | 'organization'
  | 'membership'
  | 'campaign'
  | 'walletEntry'
  | 'topUpRequest'
  | 'user'
  | 'session'
  | 'securityAuditEvent'
  | 'identityAuditEvent'
>;

const INSENSITIVE = { mode: 'insensitive' } as const;

function organizationStatus(suspendedAt: Date | null): 'ACTIVE' | 'SUSPENDED' {
  return suspendedAt ? 'SUSPENDED' : 'ACTIVE';
}

@Injectable()
export class PrismaSupportStore implements SupportStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SupportClient) {}

  async searchOrganizations(
    input: SupportOrganizationSearchInput,
  ): Promise<readonly SupportOrganizationSummary[]> {
    const organizations = await this.prisma.organization.findMany({
      where: {
        ...(input.query === undefined
          ? {}
          : {
              OR: [
                { name: { contains: input.query, ...INSENSITIVE } },
                { slug: { contains: input.query, ...INSENSITIVE } },
              ],
            }),
        ...(input.status === 'ACTIVE'
          ? { suspendedAt: null }
          : input.status === 'SUSPENDED'
            ? { suspendedAt: { not: null } }
            : {}),
        ...(input.afterSlug === undefined ? {} : { slug: { gt: input.afterSlug } }),
      },
      orderBy: { slug: 'asc' },
      take: input.limit,
      select: {
        id: true,
        name: true,
        slug: true,
        suspendedAt: true,
        createdAt: true,
        _count: { select: { memberships: true, campaigns: true } },
      },
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organizationStatus(organization.suspendedAt),
      createdAt: organization.createdAt,
      memberCount: organization._count.memberships,
      campaignCount: organization._count.campaigns,
    }));
  }

  async findOrganizationDetail(
    organizationId: string,
  ): Promise<SupportOrganizationDetail | undefined> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        suspendedAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { memberships: true, campaigns: true } },
      },
    });
    if (!organization) return undefined;

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organizationStatus(organization.suspendedAt),
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      suspendedAt: organization.suspendedAt,
      memberCount: organization._count.memberships,
      campaignCount: organization._count.campaigns,
    };
  }

  async listMembers(
    organizationId: string,
    limit: number,
  ): Promise<readonly SupportMemberRecord[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId },
      orderBy: { user: { email: 'asc' } },
      take: limit,
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true, status: true, lockedUntil: true } },
      },
    });

    return memberships.map((membership) => ({
      userId: membership.userId,
      email: membership.user.email,
      userStatus: membership.user.status,
      role: membership.role,
      joinedAt: membership.createdAt,
      lockedUntil: membership.user.lockedUntil,
    }));
  }

  async diagnostics(organizationId: string): Promise<OrganizationDiagnosticsRecord | undefined> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        billingProfile: { select: { organizationId: true } },
        _count: { select: { memberships: true, securityAuditEvents: true } },
      },
    });
    if (!organization) return undefined;

    const [statusCounts, emergencyStoppedCount, recentCampaigns, walletBalances, topUpRequests] =
      await Promise.all([
        this.prisma.campaign.groupBy({
          by: ['status'],
          where: { organizationId },
          _count: { _all: true },
        }),
        this.prisma.campaign.count({
          where: { organizationId, emergencyStoppedAt: { not: null } },
        }),
        this.prisma.campaign.findMany({
          where: { organizationId },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            name: true,
            status: true,
            emergencyStoppedAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.walletEntry.groupBy({
          by: ['currency'],
          where: { organizationId },
          _sum: { amountMinor: true },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
        this.prisma.topUpRequest.groupBy({
          by: ['currency'],
          where: { organizationId },
          _sum: { amountMinor: true },
          _count: { _all: true },
          _max: { createdAt: true },
        }),
      ]);

    return {
      memberCount: organization._count.memberships,
      auditEventCount: organization._count.securityAuditEvents,
      billingProfilePresent: organization.billingProfile !== null,
      campaigns: {
        total: statusCounts.reduce((total, group) => total + group._count._all, 0),
        byStatus: Object.fromEntries(
          statusCounts.map((group) => [group.status, group._count._all]),
        ),
        emergencyStoppedCount,
        recent: recentCampaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          emergencyStoppedAt: campaign.emergencyStoppedAt,
          updatedAt: campaign.updatedAt,
        })),
      },
      walletBalances: walletBalances.map((group) => ({
        currency: group.currency,
        amountMinor: group._sum.amountMinor ?? 0n,
        entryCount: group._count._all,
        lastEntryAt: group._max.createdAt ?? null,
      })),
      topUpRequests: topUpRequests.map((group) => ({
        currency: group.currency,
        requestCount: group._count._all,
        totalRequestedMinor: group._sum.amountMinor ?? 0n,
        lastRequestedAt: group._max.createdAt ?? null,
      })),
    };
  }

  async searchUsers(input: SupportUserSearchInput): Promise<readonly SupportUserSummary[]> {
    const users = await this.prisma.user.findMany({
      where: {
        OR: [{ email: { contains: input.query, ...INSENSITIVE } }],
        ...(input.afterEmail === undefined ? {} : { email: { gt: input.afterEmail } }),
      },
      orderBy: { email: 'asc' },
      take: input.limit,
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        lockedUntil: true,
        platformRole: { select: { role: true, grantedAt: true, revokedAt: true } },
        _count: { select: { memberships: true } },
      },
    });

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      lockedUntil: user.lockedUntil,
      platformRole:
        user.platformRole === null || user.platformRole.revokedAt !== null
          ? null
          : { role: user.platformRole.role, grantedAt: user.platformRole.grantedAt },
      membershipCount: user._count.memberships,
    }));
  }

  async findUserDetail(userId: string): Promise<SupportUserDetail | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        lockedUntil: true,
        failedLoginCount: true,
        passwordChangedAt: true,
        platformRole: { select: { role: true, grantedAt: true, revokedAt: true } },
        _count: { select: { memberships: true } },
      },
    });
    if (!user) return undefined;

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lockedUntil: user.lockedUntil,
      failedLoginCount: user.failedLoginCount,
      passwordChangedAt: user.passwordChangedAt,
      platformRole:
        user.platformRole === null || user.platformRole.revokedAt !== null
          ? null
          : { role: user.platformRole.role, grantedAt: user.platformRole.grantedAt },
      membershipCount: user._count.memberships,
    };
  }

  async listUserMemberships(
    userId: string,
    limit: number,
  ): Promise<readonly SupportMembershipRecord[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        role: true,
        createdAt: true,
        organization: { select: { id: true, name: true, slug: true } },
      },
    });

    return memberships.map((membership) => ({
      organizationId: membership.organization.id,
      organizationName: membership.organization.name,
      organizationSlug: membership.organization.slug,
      role: membership.role,
      joinedAt: membership.createdAt,
    }));
  }

  async sessionSummary(userId: string): Promise<SupportSessionSummary> {
    const now = new Date();
    const [active, revoked, expired, last] = await Promise.all([
      this.prisma.session.count({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
      }),
      this.prisma.session.count({ where: { userId, revokedAt: { not: null } } }),
      this.prisma.session.count({
        where: { userId, revokedAt: null, expiresAt: { lte: now } },
      }),
      this.prisma.session.aggregate({ where: { userId }, _max: { lastUsedAt: true } }),
    ]);

    return { active, revoked, expired, lastUsedAt: last._max.lastUsedAt ?? null };
  }

  async organizationAuditEvents(
    organizationId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]> {
    const anchor =
      input.after === undefined
        ? null
        : await this.prisma.securityAuditEvent.findUnique({
            where: {
              organizationId_id: { organizationId, id: input.after.eventId },
            },
            select: { id: true, occurredAt: true },
          });
    if (input.after !== undefined && !anchor) {
      throw new NotFoundException({
        error: {
          code: 'audit_cursor_not_found',
          message: 'That audit position no longer exists in this trail.',
        },
      });
    }

    const events = await this.prisma.securityAuditEvent.findMany({
      where: {
        organizationId,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(anchor
          ? {
              OR: [
                { occurredAt: { lt: anchor.occurredAt } },
                { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        action: true,
        outcome: true,
        scope: true,
        targetType: true,
        targetId: true,
        metadata: true,
        occurredAt: true,
        actorUserId: true,
        actor: { select: { email: true } },
      },
    });

    return events.map((event) => ({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      scope: event.scope,
      targetType: event.targetType,
      targetId: event.targetId,
      metadata: event.metadata,
      occurredAt: event.occurredAt,
      actorUserId: event.actorUserId,
      actorEmail: event.actor.email,
    }));
  }

  async userAuditEvents(
    userId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]> {
    const anchor =
      input.after === undefined
        ? null
        : await this.prisma.identityAuditEvent.findUnique({
            where: { id: input.after.eventId },
            select: { id: true, occurredAt: true, actorUserId: true },
          });
    if (
      input.after !== undefined &&
      (!anchor || anchor.actorUserId !== userId)
    ) {
      throw new NotFoundException({
        error: {
          code: 'audit_cursor_not_found',
          message: 'That audit position no longer exists in this trail.',
        },
      });
    }

    const events = await this.prisma.identityAuditEvent.findMany({
      where: {
        actorUserId: userId,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(anchor
          ? {
              OR: [
                { occurredAt: { lt: anchor.occurredAt } },
                { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        action: true,
        outcome: true,
        metadata: true,
        occurredAt: true,
        actorUserId: true,
        actor: { select: { email: true } },
      },
    });

    return events.map((event) => ({
      id: event.id,
      action: event.action,
      outcome: event.outcome,
      scope: null,
      targetType: null,
      targetId: null,
      metadata: event.metadata,
      occurredAt: event.occurredAt,
      actorUserId: event.actorUserId,
      actorEmail: event.actor.email,
    }));
  }
}
