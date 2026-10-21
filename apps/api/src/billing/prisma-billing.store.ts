import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';
import { authorizeTenantWrite, type TenantWriteSql } from '../auth/tenant-write.js';
import { DATABASE_CLIENT } from '../tokens.js';
import type { BillingProfile, BillingStore } from './billing.store.js';

type BillingClient = Pick<PrismaClient, 'walletEntry' | 'topUpRequest' | 'billingProfile'> &
  TenantWriteSql;
type BillingDatabase = BillingClient & {
  $transaction<T>(work: (tx: BillingClient) => Promise<T>): Promise<T>;
};
@Injectable()
export class PrismaBillingStore implements BillingStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: BillingDatabase) {}
  async balance(organizationId: string) {
    const sum = await this.prisma.walletEntry.aggregate({
      where: { organizationId, currency: 'UGX' },
      _sum: { amountMinor: true },
    });
    return sum._sum.amountMinor ?? 0n;
  }
  async transactions(organizationId: string, cursor?: string) {
    const anchor =
      cursor === undefined
        ? null
        : await this.prisma.walletEntry.findUnique({
            where: { organizationId_id: { organizationId, id: cursor } },
          });
    if (cursor !== undefined && !anchor)
      throw new NotFoundException({
        error: { code: 'transaction_not_found', message: 'Transaction not found.' },
      });
    return this.prisma.walletEntry.findMany({
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
      take: 51,
      select: { id: true, amountMinor: true, currency: true, description: true, createdAt: true },
    });
  }
  profile(organizationId: string) {
    return this.prisma.billingProfile.findUnique({
      where: { organizationId },
      select: { name: true, email: true, address: true },
    });
  }
  saveProfile(organizationId: string, profile: BillingProfile, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await authorizeTenantWrite(tx, organizationId, actorUserId, 'billing:update');
      return tx.billingProfile.upsert({
        where: { organizationId },
        create: { organizationId, ...profile },
        update: profile,
        select: { name: true, email: true, address: true },
      });
    });
  }
  topUps(organizationId: string) {
    return this.prisma.topUpRequest.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    });
  }
  async requestTopUp(input: {
    organizationId: string;
    createdById: string;
    amountMinor: bigint;
    idempotencyKey: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await authorizeTenantWrite(tx, input.organizationId, input.createdById, 'billing:update');
      // Unique constraint arbitrates concurrent retries; never update an existing request's payload.
      await tx.topUpRequest.createMany({
        data: [{ ...input, id: randomUUID(), currency: 'UGX' }],
        skipDuplicates: true,
      });
      return tx.topUpRequest.findUniqueOrThrow({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
    });
  }
}
