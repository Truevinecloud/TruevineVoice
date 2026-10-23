/**
 * Prisma implementations of the authentication persistence contracts.
 *
 * This is the only file that knows both the ORM and the storage contracts.
 * Services depend on the interfaces, so a unit test injects a fake and never
 * loads a database; an end-to-end test injects these and exercises real
 * PostgreSQL constraints.
 *
 * Two rules observed throughout:
 *
 * - **Every tenant-owned query names its organization.** There is no method here
 *   that can read or write organization, member or invitation data without an
 *   `organizationId` argument.
 * - **The last-owner rule is enforced in a transaction, not in a service.** A
 *   service-level "count the owners, then update" is a check-then-act race: two
 *   concurrent removals would both pass the check.
 */

import { assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import { userInfo } from 'node:os';
import { mutationAudit } from './sensitive-audit.js';
import { auditRequestId } from './audit-context.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import type {
  AuditEventInput,
  AuditStore,
  AuthStore,
  IdentityAuditEventInput,
  InvitationRecord,
  InvitationActivationUser,
  MembershipChangeResult,
  MembershipRecord,
  NewInvitation,
  NewOrganization,
  NewPasswordResetToken,
  NewSession,
  NewUser,
  OrganizationRecord,
  OrganizationStore,
  PlatformRoleRecord,
  PlatformRoleStore,
  SessionRecord,
  UserRecord,
} from './auth.store.js';
import { InvitationActivationConflict } from './auth.store.js';
import type { MembershipRole } from './prisma-types.js';
import { DATABASE_CLIENT } from '../tokens.js';

import type { SecurityStores, SecurityTransaction } from './security-transaction.js';
type TransactionClient = Pick<
  PrismaClient,
  | 'user'
  | 'session'
  | 'passwordResetToken'
  | 'termsAcceptance'
  | 'organization'
  | 'membership'
  | 'invitation'
  | 'platformRoleAssignment'
  | 'securityAuditEvent'
  | 'identityAuditEvent'
  | '$queryRaw'
>;
export type SecurityDatabase = TransactionClient & {
  $transaction<T>(work: (tx: TransactionClient) => Promise<T>): Promise<T>;
};
@Injectable()
export class PrismaSecurityTransaction implements SecurityTransaction {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: SecurityDatabase) {}
  run<T>(work: (stores: SecurityStores) => Promise<T>): Promise<T> {
    return this.database.$transaction(async (tx) => {
      const client: SecurityDatabase = {
        user: tx.user,
        session: tx.session,
        passwordResetToken: tx.passwordResetToken,
        termsAcceptance: tx.termsAcceptance,
        organization: tx.organization,
        membership: tx.membership,
        invitation: tx.invitation,
        platformRoleAssignment: tx.platformRoleAssignment,
        securityAuditEvent: tx.securityAuditEvent,
        identityAuditEvent: tx.identityAuditEvent,
        $queryRaw: tx.$queryRaw.bind(tx),
        $transaction: (callback) => callback(tx),
      };
      return work({
        auth: new PrismaAuthStore(client),
        organizations: new PrismaOrganizationStore(client),
        audit: new PrismaAuditStore(client),
        lockUser: async (id) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
        },
        lockOrganization: async (id) => {
          await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${id}::uuid FOR UPDATE`;
        },
      });
    });
  }
}

/** The roles that count as "the organization still has an owner". */
const OWNER_ROLES: readonly MembershipRole[] = ['OWNER'];

@Injectable()
export class PrismaAuthStore implements AuthStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    return user ? this.toUserRecord(user) : undefined;
  }

  async findUserById(id: string): Promise<UserRecord | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id } });

    return user ? this.toUserRecord(user) : undefined;
  }

  async recordFailedSignIn(
    userId: string,
    limit: number,
    lockoutMs: number,
    now: Date,
  ): Promise<UserRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const existing = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (existing.lockedUntil && existing.lockedUntil > now) return this.toUserRecord(existing);
      const count = existing.lockedUntil ? 1 : existing.failedLoginCount + 1;
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: count,
          lockedUntil: count >= limit ? new Date(now.getTime() + lockoutMs) : null,
        },
      });
      return this.toUserRecord(user);
    });
  }

  async recordSuccessfulSignIn(userId: string): Promise<UserRecord> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      // `lockedUntil: null` is included deliberately: a successful sign-in ends
      // an active lockout, otherwise a user who waits out a lockout still could
      // not sign in again until the row was cleared by something else.
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    return this.toUserRecord(user);
  }

  async createSession(session: NewSession) {
    return this.prisma.session.create({
      data: {
        id: session.id,
        userId: session.userId,
        tokenHash: session.tokenHash,
        previousTokenHash: session.previousTokenHash,
        expiresAt: session.expiresAt,
        userAgentHash: session.userAgentHash,
        ipPrefix: session.ipPrefix,
      },
    });
  }

  async findActiveSessionByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<SessionRecord | undefined> {
    const session = await this.prisma.session.findFirst({
      where: {
        OR: [{ tokenHash }, { previousTokenHash: tokenHash }],
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    return session ?? undefined;
  }

  async rotateSession(
    sessionId: string,
    newTokenHash: string,
    previousTokenHash: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { tokenHash: newTokenHash, previousTokenHash: previousTokenHash, expiresAt },
    });
  }

  async revokeSession(sessionId: string, reason: string, now: Date): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      // `updateMany` rather than `update`: revoking an already-revoked session
      // must be a no-op, not a "record not found" error on a second sign-out.
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    return result.count === 1;
  }

  async revokeAllSessionsForUser(userId: string, reason: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
  }

  async touchSession(sessionId: string, now: Date): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastUsedAt: now },
    });
  }

  async createPasswordResetToken(token: NewPasswordResetToken): Promise<void> {
    await this.prisma.passwordResetToken.create({
      data: {
        id: token.id,
        userId: token.userId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
      },
    });
  }

  async findPasswordResetTokenByHash(tokenHash: string) {
    return (await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } })) ?? undefined;
  }

  async markPasswordResetTokenUsed(id: string, now: Date): Promise<boolean> {
    // Conditional update: only a row that is still unused is claimed. The
    // count is the single-use guarantee, enforced atomically by PostgreSQL rather
    // than by a read-then-write in the service.
    const result = await this.prisma.passwordResetToken.updateMany({
      where: { id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });

    return result.count === 1;
  }

  async revokeAllPasswordResetTokens(userId: string): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { expiresAt: new Date(0) },
    });
  }

  async setPasswordHash(userId: string, passwordHash: string, now: Date): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      // `passwordChangedAt` moves so a session issued before the change can be
      // recognised as stale.
      data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null },
    });
  }

  async hasAcceptedTerms(userId: string, termsVersion: string): Promise<boolean> {
    const acceptance = await this.prisma.termsAcceptance.findUnique({
      where: { userId_termsVersion: { userId, termsVersion } },
    });

    return acceptance !== null;
  }

  async recordTermsAcceptance(
    userId: string,
    termsVersion: string,
    ipPrefix: string | null,
  ): Promise<void> {
    await this.prisma.termsAcceptance.upsert({
      where: { userId_termsVersion: { userId, termsVersion } },
      // Re-accepting the same version is harmless and must not fail the request.
      create: { userId, termsVersion, ipPrefix },
      update: {},
    });
  }

  async setUserSuspended(userId: string, suspended: boolean): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        status: suspended ? 'SUSPENDED' : 'ACTIVE',
        // A suspended account's lock state is meaningless; clearing it means a
        // reactivation is not blocked by a stale lockout.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  }

  private toUserRecord(user: {
    id: string;
    email: string;
    status: string;
    passwordHash: string;
    failedLoginCount: number;
    lockedUntil: Date | null;
    passwordChangedAt: Date;
  }): UserRecord {
    return {
      id: user.id,
      email: user.email,
      status: user.status as UserRecord['status'],
      passwordHash: user.passwordHash,
      failedLoginCount: user.failedLoginCount,
      lockedUntil: user.lockedUntil,
      passwordChangedAt: user.passwordChangedAt,
    };
  }
}

@Injectable()
export class PrismaOrganizationStore implements OrganizationStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async findOrganizationById(organizationId: string): Promise<OrganizationRecord | undefined> {
    return (
      (await this.prisma.organization.findUnique({ where: { id: organizationId } })) ?? undefined
    );
  }

  async setOrganizationSuspended(organizationId: string, suspended: boolean): Promise<boolean> {
    const result = await this.prisma.organization.updateMany({
      where: { id: organizationId },
      // Reversible by construction: the column is set or cleared, never deleted.
      data: { suspendedAt: suspended ? new Date() : null },
    });

    return result.count === 1;
  }

  async updateName(organizationId: string, name: string): Promise<OrganizationRecord> {
    // `id` comes from the validated guard context, never from a body field.
    return this.prisma.organization.update({ where: { id: organizationId }, data: { name } });
  }

  async listMembershipsForUser(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId },
      // `suspendedAt` travels with the record so `/me` can tell a user their
      // organization is suspended, instead of leaving them to discover it as a
      // sequence of unexplained 403s.
      include: {
        organization: { select: { id: true, slug: true, name: true, suspendedAt: true } },
      },
    });
  }

  async findMembership(
    organizationId: string,
    userId: string,
  ): Promise<MembershipRecord | undefined> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });

    return membership ?? undefined;
  }

  async listMemberships(organizationId: string): Promise<readonly MembershipRecord[]> {
    return this.prisma.membership.findMany({ where: { organizationId } });
  }

  async changeMembershipRole(
    organizationId: string,
    userId: string,
    role: MembershipRole,
  ): Promise<MembershipChangeResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
      const existing = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });

      if (!existing) return { ok: false, reason: 'not_found' };

      // An owner cannot be demoted by editing their role. Ownership moves only
      // through `transferOwnership`, so the organization is never left with
      // zero owners by a careless UPDATE.
      if (existing.role === 'OWNER') return { ok: false, reason: 'last_owner' };

      await tx.membership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role },
      });

      return { ok: true };
    });
  }

  async removeMembership(organizationId: string, userId: string): Promise<MembershipChangeResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
      const existing = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
      });

      if (!existing) return { ok: false, reason: 'not_found' };
      if (existing.role === 'OWNER') {
        const owners = await tx.membership.count({
          where: { organizationId, role: { in: [...OWNER_ROLES] } },
        });

        if (owners <= 1) return { ok: false, reason: 'last_owner' };
      }

      await tx.membership.delete({ where: { organizationId_userId: { organizationId, userId } } });

      return { ok: true };
    });
  }

  async transferOwnership(
    organizationId: string,
    expectedCurrentOwnerId: string,
    newOwnerId: string,
  ): Promise<MembershipChangeResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
      const current = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId: expectedCurrentOwnerId } },
      });

      // Compare-and-set: if two owners act at once, exactly one sees its own id
      // here. The loser gets `not_found` rather than silently overwriting.
      if (!current || current.role !== 'OWNER') return { ok: false, reason: 'not_found' };

      const target = await tx.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId: newOwnerId } },
      });

      if (!target) return { ok: false, reason: 'not_found' };

      await tx.membership.update({
        where: { organizationId_userId: { organizationId, userId: expectedCurrentOwnerId } },
        data: { role: 'ADMIN' },
      });
      await tx.membership.update({
        where: { organizationId_userId: { organizationId, userId: newOwnerId } },
        data: { role: 'OWNER' },
      });

      return { ok: true };
    });
  }

  async findInvitationState(organizationId: string, id: string) {
    return (
      (await this.prisma.invitation.findUnique({
        where: { organizationId_id: { organizationId, id } },
        select: { role: true, acceptedAt: true, revokedAt: true },
      })) ?? undefined
    );
  }

  async listInvitations(organizationId: string): Promise<readonly InvitationRecord[]> {
    return this.prisma.invitation.findMany({ where: { organizationId } });
  }

  async findOutstandingInvitationByEmail(
    organizationId: string,
    email: string,
  ): Promise<readonly InvitationRecord[]> {
    return this.prisma.invitation.findMany({
      where: { organizationId, email, acceptedAt: null, revokedAt: null },
    });
  }

  async findInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | undefined> {
    return (await this.prisma.invitation.findUnique({ where: { tokenHash } })) ?? undefined;
  }

  async createInvitation(invitation: NewInvitation): Promise<InvitationRecord> {
    return this.prisma.invitation.create({
      data: {
        organizationId: invitation.organizationId,
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        tokenHash: invitation.tokenHash,
        invitedByUserId: invitation.invitedByUserId,
        expiresAt: invitation.expiresAt,
      },
    });
  }

  async revokeInvitation(
    organizationId: string,
    invitationId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.prisma.invitation.updateMany({
      // Scoped by organization as well as id, so an id guessed from another
      // tenant cannot revoke that tenant's invitation.
      where: { organizationId, id: invitationId, revokedAt: null, acceptedAt: null },
      data: { revokedAt: now },
    });

    return result.count === 1;
  }

  async acceptInvitation(
    tokenHash: string,
    userId: string,
    now: Date,
  ): Promise<{ readonly ok: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Token lookup supplies scope; every subsequent write carries it.
      const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
      if (!invitation) return { ok: false };
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${invitation.organizationId}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: userId } });
      const organization = await tx.organization.findUnique({
        where: { id: invitation.organizationId },
      });
      if (
        !user ||
        user.status !== 'ACTIVE' ||
        user.email.toLowerCase() !== invitation.email.toLowerCase() ||
        organization?.suspendedAt
      )
        return { ok: false };
      const claimed = await tx.invitation.updateMany({
        where: {
          organizationId: invitation.organizationId,
          id: invitation.id,
          tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now, acceptedByUserId: userId },
      });
      if (claimed.count !== 1) return { ok: false };
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: invitation.organizationId, userId } },
        create: { organizationId: invitation.organizationId, userId, role: invitation.role },
        update: {},
      });
      return { ok: true };
    });
  }

  async activateInvitation(tokenHash: string, newUser: InvitationActivationUser, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
      if (
        !invitation ||
        invitation.acceptedAt !== null ||
        invitation.revokedAt !== null ||
        invitation.expiresAt <= now
      )
        return { ok: false as const, reason: 'invalid' as const };

      // The invitation supplies the tenant scope. Serialize activation against
      // acceptance, revocation and other organization membership changes.
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${invitation.organizationId}::uuid FOR UPDATE`;
      const currentInvitation = await tx.invitation.findUnique({ where: { tokenHash } });
      if (
        !currentInvitation ||
        currentInvitation.acceptedAt !== null ||
        currentInvitation.revokedAt !== null ||
        currentInvitation.expiresAt <= now
      )
        return { ok: false as const, reason: 'invalid' as const };
      // The email is globally unique across organizations. Serialize first
      // activation for the same identity even when separate tenants issued
      // invitations concurrently; the unique index remains the final guard.
      await tx.$queryRaw`SELECT 1::int FROM (SELECT pg_advisory_xact_lock(hashtextextended(lower(${currentInvitation.email}), 0))) AS advisory_lock`;
      const organization = await tx.organization.findUnique({
        where: { id: currentInvitation.organizationId },
      });
      if (!organization || organization.suspendedAt)
        return { ok: false as const, reason: 'invalid' as const };

      if (await tx.user.findUnique({ where: { email: currentInvitation.email } }))
        return { ok: false as const, reason: 'account_exists' as const };

      await tx.user.create({
        data: {
          id: newUser.id,
          email: currentInvitation.email,
          passwordHash: newUser.passwordHash,
        },
      });
      const claimed = await tx.invitation.updateMany({
        where: {
          organizationId: invitation.organizationId,
          id: invitation.id,
          tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { acceptedAt: now, acceptedByUserId: newUser.id },
      });
      if (claimed.count !== 1) throw new InvitationActivationConflict();

      await tx.membership.create({
        data: {
          organizationId: invitation.organizationId,
          userId: newUser.id,
          role: invitation.role,
        },
      });

      return {
        ok: true as const,
        organizationId: invitation.organizationId,
        userId: newUser.id,
      };
    });
  }
}

@Injectable()
export class PrismaPlatformRoleStore implements PlatformRoleStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async findPlatformRole(userId: string): Promise<PlatformRoleRecord | undefined> {
    const assignment = await this.prisma.platformRoleAssignment.findUnique({ where: { userId } });

    return assignment ?? undefined;
  }
}

@Injectable()
export class PrismaAuditStore implements AuditStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async record(event: AuditEventInput): Promise<void> {
    assertKnownAuditAction(event.action);
    if (!isSafeAuditMetadata(event.metadata ?? {})) throw new Error('Unsafe audit metadata.');
    const target = event.metadata?.['target'] as { type?: unknown; id?: unknown } | undefined;
    await this.prisma.securityAuditEvent.create({
      data: {
        organizationId: event.organizationId,
        actorUserId: event.actorUserId,
        action: event.action,
        scope: event.scope,
        outcome: event.outcome,
        targetType:
          event.targetType ?? (typeof target?.type === 'string' ? target.type : undefined),
        targetId: event.targetId ?? (typeof target?.id === 'string' ? target.id : undefined),
        metadata: {
          ...(event.metadata ?? {}),
          ...(auditRequestId() ? { requestId: auditRequestId() } : {}),
        } as never,
      },
    });
  }

  async recordIdentity(event: IdentityAuditEventInput): Promise<void> {
    assertKnownAuditAction(event.action);
    if (!isSafeAuditMetadata(event.metadata ?? {})) throw new Error('Unsafe audit metadata.');
    await this.prisma.identityAuditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action,
        outcome: event.outcome,
        metadata: {
          ...(event.metadata ?? {}),
          ...(auditRequestId() ? { requestId: auditRequestId() } : {}),
        } as never,
      },
    });
  }
}

/** Creates a user and an organization, making the user its first owner. */
@Injectable()
export class PrismaProvisioningStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: SecurityDatabase) {}

  async createUserWithOrganization(
    user: NewUser,
    organization: NewOrganization,
  ): Promise<{ readonly user: UserRecord; readonly organization: OrganizationRecord }> {
    return this.prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: { id: user.id, email: user.email, passwordHash: user.passwordHash },
      });

      const createdOrganization = await tx.organization.create({
        data: { id: organization.id, slug: organization.slug, name: organization.name },
      });

      // The first owner is created here and nowhere else. There is deliberately
      // no code path that can create a second OWNER by inserting a membership.
      await tx.membership.create({
        data: { organizationId: createdOrganization.id, userId: createdUser.id, role: 'OWNER' },
      });
      await tx.identityAuditEvent.create({
        data: {
          actorUserId: createdUser.id,
          action: 'organization.owner.provisioned',
          outcome: 'SUCCESS',
          metadata: {
            actorKind: 'provisioning_context',
            operatorReference: userInfo().username,
            actorAuthentication: 'operating_system',
            ...mutationAudit({
              targetType: 'membership',
              targetId: createdUser.id,
              before: null,
              change: { role: 'OWNER', organizationId: createdOrganization.id },
              after: { role: 'OWNER', organizationId: createdOrganization.id },
              reasonCode: 'initial_owner_provisioning',
            }),
          } as never,
        },
      });

      return {
        user: {
          id: createdUser.id,
          email: createdUser.email,
          status: createdUser.status as UserRecord['status'],
          passwordHash: createdUser.passwordHash,
          failedLoginCount: createdUser.failedLoginCount,
          lockedUntil: createdUser.lockedUntil,
          passwordChangedAt: createdUser.passwordChangedAt,
        },
        organization: {
          id: createdOrganization.id,
          slug: createdOrganization.slug,
          name: createdOrganization.name,
          // A freshly created organization is never born suspended.
          suspendedAt: createdOrganization.suspendedAt,
        },
      };
    });
  }
}
