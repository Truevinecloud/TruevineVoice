import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import type {
  AuditorAuditCursor,
  AuditorAuditEventRecord,
  AuditorAuditTrailInput,
  AuditorOrganizationInput,
  AuditorOrganizationSummary,
  AuditorStore,
} from './audit.store.js';

type AuditorClient = Pick<
  PrismaClient,
  | 'identityAuditEvent'
  | 'securityAuditEvent'
  | 'organization'
  | 'platformRoleAssignment'
>;

/**
 * Newest-first comparison across the two trails, identical in spirit to the
 * technical store: order on `(occurredAt, id)` so the merge matches each
 * individual query. Ids are canonical lowercase hex, so JavaScript string
 * comparison agrees with PostgreSQL's byte-order comparison of `uuid`.
 */
function newerFirst(
  a: { readonly occurredAt: Date; readonly id: string },
  b: { readonly occurredAt: Date; readonly id: string },
): number {
  const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function organizationStatus(suspendedAt: Date | null): 'ACTIVE' | 'SUSPENDED' {
  return suspendedAt ? 'SUSPENDED' : 'ACTIVE';
}

@Injectable()
export class PrismaAuditorStore implements AuditorStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: AuditorClient) {}

  async platformAuditEvents(
    input: AuditorAuditTrailInput,
  ): Promise<readonly AuditorAuditEventRecord[]> {
    const anchor = await this.resolveAnchor(input.after);
    const action = input.action === undefined ? {} : { action: input.action };
    const position = anchor
      ? {
          OR: [
            { occurredAt: { lt: anchor.occurredAt } },
            { occurredAt: anchor.occurredAt, id: { lt: anchor.id } },
          ],
        }
      : {};

    const [identity, security] = await Promise.all([
      this.prisma.identityAuditEvent.findMany({
        where: { ...action, ...position },
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
      }),
      this.prisma.securityAuditEvent.findMany({
        // The scope filter is the tenant-isolation boundary of this trail.
        // Organization-scoped rows describe customer activity and never appear
        // here, whatever the actor's other permissions may be. An auditor sees
        // the platform, not into a tenant's account.
        where: { scope: 'PLATFORM', ...action, ...position },
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
      }),
    ]);

    const merged: AuditorAuditEventRecord[] = [
      ...identity.map(
        (event): AuditorAuditEventRecord => ({
          id: event.id,
          trail: 'identity',
          action: event.action,
          outcome: event.outcome,
          scope: null,
          targetType: null,
          targetId: null,
          occurredAt: event.occurredAt,
          actorUserId: event.actorUserId,
          actorEmail: event.actor.email,
          metadata: event.metadata,
        }),
      ),
      ...security.map(
        (event): AuditorAuditEventRecord => {
          // Fail closed at the boundary. The query filters `scope: 'PLATFORM'`,
          // but the tenant-isolation guarantee must not depend on a single
          // `where` clause surviving future edits. If anything other than a
          // platform-scoped row reaches this mapper, the trail is not returned
          // at all - a customer's activity must never appear in the platform
          // audit trail, and a silent drop would hide the fact that it nearly
          // did.
          if (event.scope !== 'PLATFORM') {
            throw new Error(
              `Refusing to surface a non-platform security audit event (scope=${event.scope}).`,
            );
          }

          return {
            id: event.id,
            trail: 'security',
            action: event.action,
            outcome: event.outcome,
            scope: event.scope,
            targetType: event.targetType,
            targetId: event.targetId,
            occurredAt: event.occurredAt,
            actorUserId: event.actorUserId,
            actorEmail: event.actor.email,
            metadata: event.metadata,
          };
        },
      ),
    ];

    return merged.sort(newerFirst).slice(0, input.limit);
  }

  async organizationSummaries(
    input: AuditorOrganizationInput,
  ): Promise<readonly AuditorOrganizationSummary[]> {
    const organizations = await this.prisma.organization.findMany({
      where: input.afterSlug === undefined ? {} : { slug: { gt: input.afterSlug } },
      orderBy: { slug: 'asc' },
      take: input.limit,
      // Metadata only: identity, status and a member count. No billing profile,
      // no wallet, no campaign content, no members. Those belong to support
      // diagnostics, which the auditor does not hold.
      select: {
        id: true,
        name: true,
        slug: true,
        suspendedAt: true,
        createdAt: true,
        _count: { select: { memberships: true } },
      },
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organizationStatus(organization.suspendedAt),
      createdAt: organization.createdAt,
      memberCount: organization._count.memberships,
    }));
  }

  async countOrganizations(): Promise<number> {
    return this.prisma.organization.count();
  }

  async platformRoleCounts(): Promise<readonly { readonly role: string; readonly count: number }[]> {
    const rows = await this.prisma.platformRoleAssignment.groupBy({
      by: ['role'],
      where: { revokedAt: null },
      _count: { _all: true },
    });

    return rows.map((row) => ({ role: row.role, count: row._count._all }));
  }

  /**
   * Resolves a cursor inside the trail it names. A cursor pointing at an event
   * that is gone - or at a security event that is no longer platform-scoped - is
   * reported as "that position no longer exists" rather than silently restarting
   * from the newest page, so a stale link cannot masquerade as a fresh view.
   */
  private async resolveAnchor(
    cursor: AuditorAuditCursor | undefined,
  ): Promise<{ readonly id: string; readonly occurredAt: Date } | null> {
    if (cursor === undefined) return null;

    const anchor =
      cursor.trail === 'identity'
        ? await this.prisma.identityAuditEvent.findUnique({
            where: { id: cursor.eventId },
            select: { id: true, occurredAt: true },
          })
        : await this.prisma.securityAuditEvent.findFirst({
            where: { id: cursor.eventId, scope: 'PLATFORM' },
            select: { id: true, occurredAt: true },
          });

    if (!anchor) {
      throw new NotFoundException({
        error: {
          code: 'audit_cursor_not_found',
          message: 'That audit position no longer exists in this trail.',
        },
      });
    }

    return anchor;
  }
}
