import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaTechnicalStore } from './prisma-technical.store.js';

const ACTOR_ID = '00000000-0000-4000-8000-000000000003';
const IDENTITY_ID = '10000000-0000-4000-8000-000000000001';
const SECURITY_ID = '20000000-0000-4000-8000-000000000001';

interface Row {
  readonly id: string;
  readonly action: string;
  readonly outcome: 'SUCCESS' | 'DENIED';
  readonly scope?: 'ORGANIZATION' | 'PLATFORM';
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly metadata: unknown;
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly actor: { email: string };
}

function fixture() {
  const identityRows: Row[] = [];
  const securityRows: Row[] = [];
  /** The `where` each security query was issued with, for scope assertions. */
  const securityWheres: Record<string, unknown>[] = [];

  /** Applies the subset of Prisma `where` semantics this store actually uses. */
  function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'OR') continue;
      if (key === 'scope') {
        if (row.scope !== value) return false;
        continue;
      }
      if (key === 'action') {
        if (row.action !== value) return false;
        continue;
      }
      // Unknown predicates are not exercised by these tests.
    }

    const or = where['OR'];
    if (!Array.isArray(or)) return true;

    // The cursor position clause the store builds:
    //   { occurredAt: { lt } } OR { occurredAt, id: { lt } }
    return or.some((clause: Record<string, unknown>) => {
      const occurredAt = clause['occurredAt'] as Date | { lt: Date } | undefined;
      const id = clause['id'] as { lt: string } | undefined;

      if (occurredAt instanceof Date) {
        return row.occurredAt.getTime() === occurredAt.getTime() && row.id < id!.lt;
      }
      if (occurredAt && 'lt' in occurredAt) {
        return row.occurredAt.getTime() < occurredAt.lt.getTime();
      }
      return false;
    });
  }

  const database = {
    identityAuditEvent: {
      findMany: vi.fn(
        async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) =>
          identityRows
            .filter((row) => matches(row, where))
            .sort((a, b) =>
              b.occurredAt.getTime() - a.occurredAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
            )
            .slice(0, take ?? identityRows.length),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = identityRows.find((candidate) => candidate.id === where.id);
        return row ? { id: row.id, occurredAt: row.occurredAt } : null;
      }),
    },
    securityAuditEvent: {
      findMany: vi.fn(
        async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) => {
          securityWheres.push(where);
          return securityRows
            .filter((row) => matches(row, where))
            .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
            .slice(0, take ?? securityRows.length);
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; scope?: string } }) => {
        const row = securityRows.find(
          (candidate) =>
            candidate.id === where.id &&
            (where.scope === undefined || candidate.scope === where.scope),
        );
        return row ? { id: row.id, occurredAt: row.occurredAt } : null;
      }),
    },
  };

  return {
    store: new PrismaTechnicalStore(database as never),
    identityRows,
    securityRows,
    securityWheres,
  };
}

function anIdentityRow(overrides: Partial<Row> = {}): Row {
  return {
    id: IDENTITY_ID,
    action: 'auth.sign_in.succeeded',
    outcome: 'SUCCESS',
    metadata: {},
    occurredAt: new Date('2026-10-20T00:00:00Z'),
    actorUserId: ACTOR_ID,
    actor: { email: 'operator@example.invalid' },
    ...overrides,
  };
}

function aSecurityRow(overrides: Partial<Row> = {}): Row {
  return {
    id: SECURITY_ID,
    action: 'platform.campaign.emergency_stopped',
    outcome: 'SUCCESS',
    scope: 'PLATFORM',
    targetType: 'campaign',
    targetId: 'cmp-1',
    metadata: {},
    occurredAt: new Date('2026-10-20T00:00:00Z'),
    actorUserId: ACTOR_ID,
    actor: { email: 'operator@example.invalid' },
    ...overrides,
  };
}

describe('PrismaTechnicalStore platform audit trail', () => {
  let state: ReturnType<typeof fixture>;

  beforeEach(() => {
    state = fixture();
  });

  it('merges the two trails newest first and tags each row with its trail', async () => {
    state.identityRows.push(anIdentityRow({ occurredAt: new Date('2026-10-20T00:00:00Z') }));
    state.securityRows.push(
      aSecurityRow({
        id: SECURITY_ID,
        occurredAt: new Date('2026-10-20T01:00:00Z'),
        action: 'platform.campaign.emergency_stopped',
      }),
    );

    const events = await state.store.platformAuditEvents({ limit: 50 });

    expect(events.map((event) => event.trail)).toEqual(['security', 'identity']);
    expect(events[0]).toMatchObject({
      id: SECURITY_ID,
      trail: 'security',
      scope: 'PLATFORM',
      targetType: 'campaign',
      actorEmail: 'operator@example.invalid',
    });
  });

  it('excludes organization-scoped security rows by querying only PLATFORM', async () => {
    state.identityRows.push(anIdentityRow());
    state.securityRows.push(aSecurityRow());
    // A customer's own tenant activity, which must never surface here.
    state.securityRows.push(
      aSecurityRow({
        id: '20000000-0000-4000-8000-0000000000ff',
        scope: 'ORGANIZATION',
        action: 'organization.profile_updated',
      }),
    );

    const events = await state.store.platformAuditEvents({ limit: 50 });

    expect(state.securityWheres[0]).toMatchObject({ scope: 'PLATFORM' });
    expect(events.map((event) => event.action)).toEqual([
      'platform.campaign.emergency_stopped',
      'auth.sign_in.succeeded',
    ]);
    expect(events.some((event) => event.action === 'organization.profile_updated')).toBe(false);
  });

  it('filters both trails by the requested action', async () => {
    state.identityRows.push(anIdentityRow({ action: 'auth.sign_in.succeeded' }));
    state.identityRows.push(anIdentityRow({ id: '10000000-0000-4000-8000-000000000002', action: 'auth.sign_out' }));

    const events = await state.store.platformAuditEvents({
      action: 'auth.sign_out',
      limit: 50,
    });

    expect(events.map((event) => event.action)).toEqual(['auth.sign_out']);
  });

  it('resolves a security cursor only inside the platform scope', async () => {
    state.securityRows.push(aSecurityRow());

    await expect(
      state.store.platformAuditEvents({
        after: { trail: 'security', eventId: SECURITY_ID },
        limit: 50,
      }),
    ).resolves.toBeDefined();

    await expect(
      state.store.platformAuditEvents({
        after: { trail: 'security', eventId: '20000000-0000-4000-8000-0000000000ff' },
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports a missing identity cursor as not found', async () => {
    await expect(
      state.store.platformAuditEvents({
        after: { trail: 'identity', eventId: '10000000-0000-4000-8000-0000000000ff' },
        limit: 50,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('caps the merged page at the requested limit', async () => {
    state.identityRows.push(anIdentityRow());
    state.securityRows.push(aSecurityRow({ id: SECURITY_ID }));

    const events = await state.store.platformAuditEvents({ limit: 1 });

    expect(events).toHaveLength(1);
  });
});
