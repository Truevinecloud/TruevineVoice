import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import type {
  BillingAdminOrganizationQuery,
  BillingAdminOrganizationSummary,
  BillingAdminStore,
  BillingAdminTopUpRequest,
  BillingAdminWalletBalance,
  BillingAdminWalletEntry,
} from './billing-admin.store.js';

type BillingAdminClient = Pick<
  PrismaClient,
  'organization' | 'membership' | 'campaign' | 'billingProfile' | 'walletEntry' | 'topUpRequest'
>;

const INSENSITIVE = { mode: 'insensitive' } as const;

function organizationStatus(suspendedAt: Date | null): 'ACTIVE' | 'SUSPENDED' {
  return suspendedAt ? 'SUSPENDED' : 'ACTIVE';
}

@Injectable()
export class PrismaBillingAdminStore implements BillingAdminStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: BillingAdminClient) {}

  async listOrganizations(
    input: BillingAdminOrganizationQuery,
  ): Promise<readonly BillingAdminOrganizationSummary[]> {
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
        billingProfile: { select: { organizationId: true } },
        _count: { select: { memberships: true, campaigns: true } },
      },
    });

    const organizationIds = organizations.map((organization) => organization.id);
    const [walletGroups, topUpGroups] = await Promise.all([
      this.prisma.walletEntry.groupBy({
        by: ['organizationId', 'currency'],
        where: { organizationId: { in: organizationIds } },
        _sum: { amountMinor: true },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      this.prisma.topUpRequest.groupBy({
        by: ['organizationId', 'currency'],
        where: { organizationId: { in: organizationIds } },
        _sum: { amountMinor: true },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
    ]);

    return organizations.map((organization) => {
      const walletBalances: BillingAdminWalletBalance[] = walletGroups
        .filter((group) => group.organizationId === organization.id)
        .map((group) => ({
          currency: group.currency,
          amountMinor: group._sum.amountMinor ?? 0n,
          entryCount: group._count._all,
          lastEntryAt: group._max.createdAt ?? null,
        }));
      const topUpRequests = topUpGroups
        .filter((group) => group.organizationId === organization.id)
        .map((group) => ({
          currency: group.currency,
          requestCount: group._count._all,
          totalRequestedMinor: group._sum.amountMinor ?? 0n,
          lastRequestedAt: group._max.createdAt ?? null,
        }));

      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organizationStatus(organization.suspendedAt),
        createdAt: organization.createdAt,
        memberCount: organization._count.memberships,
        campaignCount: organization._count.campaigns,
        billingProfilePresent: organization.billingProfile !== null,
        walletBalances,
        topUpRequests,
      };
    });
  }

  async findOrganization(id: string): Promise<BillingAdminOrganizationSummary | undefined> {
    const organizations = await this.listOrganizations({ limit: 1000 });
    return organizations.find((organization) => organization.id === id);
  }

  async walletEntries(
    organizationId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<readonly BillingAdminWalletEntry[]> {
    const anchor =
      cursor === undefined
        ? null
        : await this.prisma.walletEntry.findUnique({
            where: { organizationId_id: { organizationId, id: cursor } },
            select: { id: true, createdAt: true },
          });
    if (cursor !== undefined && !anchor) {
      throw new NotFoundException({
        error: { code: 'wallet_cursor_not_found', message: 'That wallet position no longer exists.' },
      });
    }

    const entries = await this.prisma.walletEntry.findMany({
      where: {
        organizationId,
        ...(anchor
          ? {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        reference: true,
        description: true,
        createdAt: true,
      },
    });

    return entries.map((entry) => ({
      id: entry.id,
      amountMinor: entry.amountMinor,
      currency: entry.currency,
      reference: entry.reference,
      description: entry.description,
      createdAt: entry.createdAt,
    }));
  }

  async topUpRequests(input: {
    organizationId?: string;
    limit: number;
  }): Promise<readonly BillingAdminTopUpRequest[]> {
    const requests = await this.prisma.topUpRequest.findMany({
      where: input.organizationId === undefined ? {} : { organizationId: input.organizationId },
      orderBy: { createdAt: 'desc' },
      take: input.limit + 1,
      select: {
        id: true,
        organizationId: true,
        amountMinor: true,
        currency: true,
        createdById: true,
        createdAt: true,
        organization: { select: { name: true, slug: true } },
      },
    });

    return requests.map((request) => ({
      id: request.id,
      organizationId: request.organizationId,
      organizationName: request.organization.name,
      organizationSlug: request.organization.slug,
      amountMinor: request.amountMinor,
      currency: request.currency,
      createdById: request.createdById,
      createdAt: request.createdAt,
    }));
  }
}
