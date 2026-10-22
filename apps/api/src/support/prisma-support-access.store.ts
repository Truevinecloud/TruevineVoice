import { Inject, Injectable } from '@nestjs/common';
import { assertKnownAuditAction, isSafeAuditMetadata } from '@truevine/auth';
import type { PrismaClient } from '@truevine/database';

import { auditRequestId } from '../auth/audit-context.js';
import { DATABASE_CLIENT } from '../tokens.js';
import type {
  NewSupportAccessSession,
  SupportAccessResolution,
  SupportAccessStore,
} from './support-access.store.js';

type AccessClient = Pick<PrismaClient, '$transaction' | 'organization' | 'supportAccessSession'>;
const ALLOWED_ROLES = ['SUPPORT_ADMIN'] as const;

function auditMetadata(values: Record<string, unknown>) {
  const metadata = { ...values, ...(auditRequestId() ? { requestId: auditRequestId() } : {}) };
  if (!isSafeAuditMetadata(metadata)) throw new Error('Unsafe support access audit metadata.');
  return metadata;
}

@Injectable()
export class PrismaSupportAccessStore implements SupportAccessStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: AccessClient) {}

  async create(input: NewSupportAccessSession): Promise<'created' | 'not_found' | 'unauthorized'> {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true },
      });
      if (!organization) return 'not_found';

      const authSession = await tx.session.findFirst({
        where: {
          id: input.authSessionId,
          userId: input.actorUserId,
          revokedAt: null,
          expiresAt: { gt: input.createdAt },
          user: {
            is: {
              status: 'ACTIVE',
              platformRole: { is: { revokedAt: null, role: { in: [...ALLOWED_ROLES] } } },
            },
          },
        },
        select: { id: true },
      });
      if (!authSession) return 'unauthorized';

      await tx.supportAccessSession.create({ data: input });
      assertKnownAuditAction('platform.support.access_started');
      await tx.identityAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          action: 'platform.support.access_started',
          outcome: 'SUCCESS',
          metadata: auditMetadata({
            supportSessionId: input.id,
            organizationId: input.organizationId,
            reasonCode: input.reasonCode,
            expiresAt: input.expiresAt.toISOString(),
          }) as never,
        },
      });
      return 'created';
    });
  }

  async resolve(input: {
    tokenHash: string;
    actorUserId: string;
    authSessionId: string;
    now: Date;
  }): Promise<SupportAccessResolution> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.supportAccessSession.findFirst({
        where: {
          tokenHash: input.tokenHash,
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          revokedAt: null,
          authSession: {
            is: {
              revokedAt: null,
              expiresAt: { gt: input.now },
              user: {
                is: {
                  status: 'ACTIVE',
                  platformRole: { is: { revokedAt: null, role: { in: [...ALLOWED_ROLES] } } },
                },
              },
            },
          },
        },
        select: {
          id: true,
          organizationId: true,
          actorUserId: true,
          reasonCode: true,
          expiresAt: true,
        },
      });
      if (row) {
        if (row.expiresAt.getTime() > input.now.getTime()) return { kind: 'active', context: row };
        await tx.supportAccessSession.updateMany({
          where: { organizationId: row.organizationId, id: row.id, revokedAt: null },
          data: { revokedAt: input.now },
        });
        assertKnownAuditAction('platform.support.access_expired');
        await tx.identityAuditEvent.create({
          data: {
            actorUserId: input.actorUserId,
            action: 'platform.support.access_expired',
            outcome: 'SUCCESS',
            metadata: auditMetadata({
              supportSessionId: row.id,
              organizationId: row.organizationId,
            }),
          },
        });
        return { kind: 'expired' };
      }

      const expired = await tx.supportAccessSession.findFirst({
        where: {
          tokenHash: input.tokenHash,
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          revokedAt: null,
        },
        select: { id: true, organizationId: true, expiresAt: true, reasonCode: true },
      });
      if (expired) {
        if (expired.expiresAt.getTime() <= input.now.getTime()) {
          await tx.supportAccessSession.updateMany({
            where: { organizationId: expired.organizationId, id: expired.id, revokedAt: null },
            data: { revokedAt: input.now },
          });
          assertKnownAuditAction('platform.support.access_expired');
          await tx.identityAuditEvent.create({
            data: {
              actorUserId: input.actorUserId,
              action: 'platform.support.access_expired',
              outcome: 'SUCCESS',
              metadata: auditMetadata({
                supportSessionId: expired.id,
                organizationId: expired.organizationId,
                reasonCode: expired.reasonCode,
              }),
            },
          });
          return { kind: 'expired' };
        }
        const authorization = await tx.session.findFirst({
          where: {
            id: input.authSessionId,
            userId: input.actorUserId,
            revokedAt: null,
            expiresAt: { gt: input.now },
            user: {
              is: {
                status: 'ACTIVE',
                platformRole: { is: { revokedAt: null, role: { in: [...ALLOWED_ROLES] } } },
              },
            },
          },
          select: { id: true },
        });
        if (!authorization) {
          await tx.supportAccessSession.updateMany({
            where: { organizationId: expired.organizationId, id: expired.id, revokedAt: null },
            data: { revokedAt: input.now },
          });
          assertKnownAuditAction('platform.support.access_revoked');
          await tx.identityAuditEvent.create({
            data: {
              actorUserId: input.actorUserId,
              action: 'platform.support.access_revoked',
              outcome: 'SUCCESS',
              metadata: auditMetadata({
                supportSessionId: expired.id,
                organizationId: expired.organizationId,
                reasonCode: expired.reasonCode,
                revocationReason: 'operator_authorization_lost',
              }),
            },
          });
        }
        return { kind: 'invalid' };
      }
      return { kind: 'invalid' };
    });
  }

  async revoke(input: {
    tokenHash: string;
    actorUserId: string;
    authSessionId: string;
    now: Date;
  }): Promise<'revoked' | 'expired' | 'invalid'> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.supportAccessSession.findFirst({
        where: {
          tokenHash: input.tokenHash,
          actorUserId: input.actorUserId,
          authSessionId: input.authSessionId,
          revokedAt: null,
        },
        select: { id: true, organizationId: true, expiresAt: true, reasonCode: true },
      });
      if (!row) return 'invalid';
      const expired = row.expiresAt.getTime() <= input.now.getTime();
      const update = await tx.supportAccessSession.updateMany({
        where: { organizationId: row.organizationId, id: row.id, revokedAt: null },
        data: { revokedAt: input.now },
      });
      if (update.count === 0) return expired ? 'expired' : 'invalid';
      const action = expired ? 'platform.support.access_expired' : 'platform.support.access_ended';
      assertKnownAuditAction(action);
      await tx.identityAuditEvent.create({
        data: {
          actorUserId: input.actorUserId,
          action,
          outcome: 'SUCCESS',
          metadata: auditMetadata({
            supportSessionId: row.id,
            organizationId: row.organizationId,
            reasonCode: row.reasonCode,
          }),
        },
      });
      return expired ? 'expired' : 'revoked';
    });
  }
}
