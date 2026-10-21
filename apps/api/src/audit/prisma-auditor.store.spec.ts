import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaAuditorStore } from './prisma-auditor.store.js';

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
  /** The `select` the organization query was issued with, for allowlist assertions. */
  const organizationSelects: Record<string, unknown>[] = [];

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
    }

    const or = where['OR'];
    if (!Array.isArray(or)) return true;

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

  const organizationRows: {
    id: string;
    name: string;
    slug: string;
    suspendedAt: Date | null;
    createdAt: Date;
    _count: { memberships: number };
  }[] = [];

  const database = {
    identityAuditEvent: {
      findMany: vi.fn(
        async ({ where = {}, take }: { where?: Record<string, unknown>; take?: number }) =>
          identityRows
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
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
    organization: {
      findMany: vi.fn(
        async ({
          where = {},
          take,
          select,
        }: {
          where?: Record<string, unknown>;
          take?: number;
          select?: Record<string, unknown>;
        }) => {
          organizationSelects.push(select ?? {});
          const afterSlug = (where['slug'] as { gt?: string } | undefined)?.gt;
          return organizationRows
            .filter((row) => afterSlug === undefined || row.slug > afterSlug)
            .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
            .slice(0, take ?? organizationRows.length);
        },
      ),
      count: vi.fn(async () => organizationRows.length),
    },
    platformRoleAssignment: {
      groupBy: vi.fn(
        async ({ where }: { where?: Record<string, unknown> }) => {
          expect(where).toMatchObject({ revokedAt: null });
          return [{ role: 'AUDITOR', _count: { _all: 2 } }];
        },
      ),
    },
  };

  return {
    store: new PrismaAuditorStore(database as never),
    identityRows,
    securityRows,
    securityWheres,
    organizationRows,
    organizationSelects,
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

describe('PrismaAuditorStore platform audit trail', () => {
  let state: ReturnType<typeof fixture>;

  beforeEach(() => {
    state = fixture();
  });

  it('merges the two trails newest first and tags each row with its trail', async () => {
    state.identityRows.push(anIdentityRow({ occurredAt: new Date('2026-10-20T00:00:00Z') }));
    state.securityRows.push(
      aSecurityRow({ occurredAt: new Date('2026-10-20T01:00:00Z') }),
    );

    const events = await state.store.platformAuditEvents({ limit: 50 });

    expect(events.map((event) => event.trail)).toEqual(['security', 'identity']);
    expect(events[0]).toMatchObject({
      id: SECURITY_ID,
      trail: 'security',
      scope: 'PLATFORM',
      actorEmail: 'operator@example.invalid',
    });
  });

  it('excludes organization-scoped security rows by querying only PLATFORM', async () => {
    state.identityRows.push(anIdentityRow());
    state.securityRows.push(aSecurityRow());
    state.securityRows.push(
      aSecurityRow({
        id: '20000000-0000-4000-8000-0000000000ff',
        scope: 'ORGANIZATION',
        action: 'organization.profile_updated',
      }),
    );

    const events = await state.store.platformAuditEvents({ limit: 50 });

    expect(state.securityWheres[0]).toMatchObject({ scope: 'PLATFORM' });
    expect(events.some((event) => event.action === 'organization.profile_updated')).toBe(false);
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

  it('fails closed if a non-platform security row ever reaches the mapper', async () => {
    // Regression guard for tenant isolation that does not rely on the `where`
    // clause. This simulates an adapter (or a future query edit) returning an
    // organization-scoped row anyway: the store must throw rather than place a
    // customer's activity into the platform trail. A silent drop would hide the
    // near-leak; an empty trail would look like a quiet day.
    const organizationScoped = aSecurityRow({
      id: '20000000-0000-4000-8000-0000000000ff',
      scope: 'ORGANIZATION',
      action: 'organization.profile_updated',
    });

    const violatingDatabase = {
      identityAuditEvent: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
      },
      securityAuditEvent: {
        // Deliberately ignores the `scope: 'PLATFORM'` filter.
        findMany: vi.fn(async () => [organizationScoped]),
        findFirst: vi.fn(async () => null),
      },
    };

    await expect(
      new PrismaAuditorStore(violatingDatabase as never).platformAuditEvents({ limit: 50 }),
    ).rejects.toThrow(/non-platform security audit event/i);
  });
});

describe('PrismaAuditorStore organization summaries', () => {
  let state: ReturnType<typeof fixture>;

  beforeEach(() => {
    state = fixture();
  });

  it('selects only identity, status and a member count', async () => {
    state.organizationRows.push({
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Acme',
      slug: 'acme',
      suspendedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      _count: { memberships: 4 },
    });

    const organizations = await state.store.organizationSummaries({ limit: 50 });

    expect(organizations[0]).toEqual({
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Acme',
      slug: 'acme',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      memberCount: 4,
    });

    // The select is the allowlist. It must name no billing, wallet or
    // member-detail field.
    const selected = JSON.stringify(state.organizationSelects[0]);
    expect(selected).not.toMatch(/wallet|billing|topUp|amountMinor|password/i);
  });

  it('derives status from the suspension timestamp', async () => {
    state.organizationRows.push({
      id: '30000000-0000-4000-8000-000000000002',
      name: 'Beta',
      slug: 'beta',
      suspendedAt: new Date('2026-05-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      _count: { memberships: 1 },
    });

    const organizations = await state.store.organizationSummaries({ limit: 50 });

    expect(organizations[0]!.status).toBe('SUSPENDED');
  });

  it('pages by slug using a keyset cursor', async () => {
    state.organizationRows.push(
      {
        id: '30000000-0000-4000-8000-000000000001',
        name: 'Acme',
        slug: 'acme',
        suspendedAt: null,
        createdAt: new Date(),
        _count: { memberships: 0 },
      },
      {
        id: '30000000-0000-4000-8000-000000000002',
        name: 'Beta',
        slug: 'beta',
        suspendedAt: null,
        createdAt: new Date(),
        _count: { memberships: 0 },
      },
    );

    const organizations = await state.store.organizationSummaries({
      afterSlug: 'acme',
      limit: 50,
    });

    expect(organizations.map((organization) => organization.slug)).toEqual(['beta']);
  });
});

describe('PrismaAuditorStore counts', () => {
  it('counts organizations and active platform roles', async () => {
    const state = fixture();
    state.organizationRows.push({
      id: '30000000-0000-4000-8000-000000000001',
      name: 'Acme',
      slug: 'acme',
      suspendedAt: null,
      createdAt: new Date(),
      _count: { memberships: 0 },
    });

    expect(await state.store.countOrganizations()).toBe(1);
    expect(await state.store.platformRoleCounts()).toEqual([{ role: 'AUDITOR', count: 2 }]);
  });
});
