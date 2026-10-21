import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@truevine/database';

import { DATABASE_CLIENT } from '../tokens.js';
import type {
  TechnicalAuditCursor,
  TechnicalAuditEventRecord,
  TechnicalAuditTrailInput,
  TechnicalStore,
} from './technical.store.js';

type TechnicalClient = Pick<PrismaClient, 'identityAuditEvent' | 'securityAuditEvent'>;

/**
 * Newest-first comparison across the two trails.
 *
 * Ordering is decided on `(occurredAt, id)` exactly as each individual query
 * orders it, so the merge is stable with respect to the database: events are
 * placed the same way whether they were fetched from one table or the other.
 * Ids are canonical lowercase hex, so the JavaScript comparison matches
 * PostgreSQL's byte-order comparison of `uuid` values.
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

@Injectable()
export class PrismaTechnicalStore implements TechnicalStore {
  constructor(@Inject(DATABASE_CLIENT) private readonly prisma: TechnicalClient) {}

  async platformAuditEvents(
    input: TechnicalAuditTrailInput,
  ): Promise<readonly TechnicalAuditEventRecord[]> {
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
        // The scope filter is the tenant-isolation boundary of this trail:
        // organization-scoped rows describe customer activity and never appear
        // here, whatever the actor's other permissions may be.
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

    const merged: TechnicalAuditEventRecord[] = [
      ...identity.map(
        (event): TechnicalAuditEventRecord => ({
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
        (event): TechnicalAuditEventRecord => ({
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
        }),
      ),
    ];

    return merged.sort(newerFirst).slice(0, input.limit);
  }

  /**
   * Resolves a cursor inside the trail it names.
   *
   * A cursor pointing at an event that is gone - or at a security event that
   * is no longer platform-scoped - is reported as "that position no longer
   * exists" rather than silently restarting from the newest page, so a stale
   * link cannot masquerade as a fresh view.
   */
  private async resolveAnchor(
    cursor: TechnicalAuditCursor | undefined,
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
