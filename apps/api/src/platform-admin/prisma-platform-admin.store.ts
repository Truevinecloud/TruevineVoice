import { Inject, Injectable } from '@nestjs/common';

import type { PlatformRole } from '@truevine/auth';
import { DATABASE_CLIENT } from '../tokens.js';
import { writeIdentityMutationAudit } from '../auth/sensitive-audit.js';
import type { SecurityDatabase } from '../auth/prisma-stores.js';
import type {
  PlatformAdminAssignment,
  PlatformAdminReason,
  PlatformAdminStore,
} from './platform-admin.store.js';

@Injectable()
export class PrismaPlatformAdminStore implements PlatformAdminStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async listAssignments(): Promise<readonly PlatformAdminAssignment[]> {
    const rows = await this.prisma.platformRoleAssignment.findMany({
      include: { user: { select: { email: true, status: true } } },
      orderBy: { grantedAt: 'desc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      email: row.user.email,
      status: row.user.status as 'ACTIVE' | 'SUSPENDED',
      role: row.role as PlatformRole,
      grantedByUserId: row.grantedByUserId,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt,
    }));
  }

  async findUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, status: true },
    });
    if (!user) return undefined;
    return { id: user.id, email: user.email, status: user.status as 'ACTIVE' | 'SUSPENDED' };
  }

  async searchEligibleUsers(query: string) {
    const rows = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        email: { contains: query, mode: 'insensitive' },
        platformRoleAssignment: { is: null },
      },
      select: { id: true, email: true, status: true },
      orderBy: { email: 'asc' },
      take: 20,
    });
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      status: row.status as 'ACTIVE' | 'SUSPENDED',
      platformRole: null,
    }));
  }

  async grantRole(input: {
    readonly userId: string;
    readonly role: PlatformRole;
    readonly grantedByUserId: string;
    readonly reason: PlatformAdminReason;
  }): Promise<PlatformAdminAssignment> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.platformRoleAssignment.findUnique({
        where: { userId: input.userId },
      });
      const row = await tx.platformRoleAssignment.upsert({
        where: { userId: input.userId },
        update: {
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          grantedAt: new Date(),
          revokedAt: null,
        },
        create: {
          userId: input.userId,
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          revokedAt: null,
        },
        include: { user: { select: { email: true, status: true } } },
      });

      // The assignment and its evidence commit together. A platform role change
      // is exactly the "administrative rights change" whose audit record must
      // never be optional, and there is no tenant id to hang a security-trail
      // row on, so the identity trail carries it.
      await writeIdentityMutationAudit(tx, {
        actorUserId: input.grantedByUserId,
        action: 'platform.admin.role_granted',
        targetType: 'platform_role',
        targetId: input.userId,
        before:
          existing !== null && existing.revokedAt === null ? { role: existing.role } : null,
        change: { operation: 'granted', role: input.role },
        after: { role: row.role },
        reasonCode: input.reason.reasonCode,
        justification: input.reason.justification ?? null,
        reasonSource: 'caller',
        legacy: { targetUserId: input.userId, role: input.role },
      });

      return {
        userId: row.userId,
        email: row.user.email,
        status: row.user.status as 'ACTIVE' | 'SUSPENDED',
        role: row.role as PlatformRole,
        grantedByUserId: row.grantedByUserId,
        grantedAt: row.grantedAt,
        revokedAt: row.revokedAt,
      };
    });
  }

  async revokeRole(
    userId: string,
    actorUserId: string,
    reason: PlatformAdminReason,
  ): Promise<'revoked' | 'not_found' | 'last_owner'> {
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.platformRoleAssignment.findUnique({ where: { userId } });
      if (!assignment || assignment.revokedAt) return 'not_found';
      if (assignment.role === 'PLATFORM_OWNER') {
        const owners = await tx.platformRoleAssignment.count({
          where: { role: 'PLATFORM_OWNER', revokedAt: null, userId: { not: userId } },
        });
        if (owners === 0) return 'last_owner';
      }
      await tx.platformRoleAssignment.update({
        where: { userId },
        data: { revokedAt: new Date() },
      });
      await writeIdentityMutationAudit(tx, {
        actorUserId,
        action: 'platform.admin.role_revoked',
        targetType: 'platform_role',
        targetId: userId,
        before: { role: assignment.role },
        change: { operation: 'revoked', role: assignment.role },
        after: null,
        reasonCode: reason.reasonCode,
        justification: reason.justification ?? null,
        reasonSource: 'caller',
        legacy: { targetUserId: userId, role: assignment.role },
      });
      return 'revoked';
    });
  }

  async countActiveOwners(excludingUserId?: string): Promise<number> {
    return this.prisma.platformRoleAssignment.count({
      where: {
        role: 'PLATFORM_OWNER',
        revokedAt: null,
        ...(excludingUserId ? { userId: { not: excludingUserId } } : {}),
      },
    });
  }
}
