/**
 * Unit tests for the auditor service (RBAC-011).
 *
 * Backed by in-memory fakes, not PostgreSQL, as AGENTS.md 13 requires. The fake
 * store records every input it was handed, so "did the cursor reach the store?"
 * is an assertion rather than a comment, and the E2E suite repeats the same
 * behaviour against real PostgreSQL.
 *
 * The security-critical assertions here are the read-only-and-allowlisted ones:
 * an auditor response must never carry a field the role is not entitled to, and
 * every read must be recorded before it is returned.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { FakeAuditStore } from '../../test/fakes/auth.fakes.js';

import type {
  AuditorAuditEventRecord,
  AuditorAuditTrailInput,
  AuditorOrganizationInput,
  AuditorOrganizationSummary,
  AuditorStore,
} from './audit.store.js';
import { AuditService } from './audit.service.js';

const ACTOR = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-20T00:00:00Z');

class FakeAuditorStore implements AuditorStore {
  lastAudit?: AuditorAuditTrailInput;
  lastOrganizations?: AuditorOrganizationInput;
  events: AuditorAuditEventRecord[] = [];
  organizations: AuditorOrganizationSummary[] = [];
  organizationCount = 0;
  roleCounts: { role: string; count: number }[] = [];

  async platformAuditEvents(
    input: AuditorAuditTrailInput,
  ): Promise<readonly AuditorAuditEventRecord[]> {
    this.lastAudit = input;
    return this.events;
  }

  async organizationSummaries(
    input: AuditorOrganizationInput,
  ): Promise<readonly AuditorOrganizationSummary[]> {
    this.lastOrganizations = input;
    return this.organizations;
  }

  async countOrganizations(): Promise<number> {
    return this.organizationCount;
  }

  async platformRoleCounts(): Promise<readonly { role: string; count: number }[]> {
    return this.roleCounts;
  }
}

function anAuditEvent(
  overrides: Partial<AuditorAuditEventRecord> = {},
): AuditorAuditEventRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    trail: 'identity',
    action: 'auth.sign_in.succeeded',
    outcome: 'SUCCESS',
    scope: null,
    targetType: null,
    targetId: null,
    occurredAt: NOW,
    actorUserId: ACTOR,
    actorEmail: 'operator@example.invalid',
    metadata: {},
    ...overrides,
  };
}

function anOrganization(
  overrides: Partial<AuditorOrganizationSummary> = {},
): AuditorOrganizationSummary {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    createdAt: NOW,
    memberCount: 3,
    ...overrides,
  };
}

function buildService(): {
  service: AuditService;
  store: FakeAuditorStore;
  audit: FakeAuditStore;
} {
  const store = new FakeAuditorStore();
  const audit = new FakeAuditStore();
  return { service: new AuditService(store, audit), store, audit };
}

async function expectError(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => Error,
  code?: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(type);
  if (code !== undefined) {
    expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({ error: { code } });
  }
}

describe('AuditService overview', () => {
  it('reports platform counts and states the role is read-only', async () => {
    const { service, store, audit } = buildService();
    store.organizationCount = 4;
    store.roleCounts = [
      { role: 'AUDITOR', count: 2 },
      { role: 'PLATFORM_OWNER', count: 1 },
    ];

    const result = await service.overview(ACTOR);

    expect(result.organizations.total).toBe(4);
    expect(result.platformRoles).toEqual([
      { role: 'AUDITOR', count: 2 },
      { role: 'PLATFORM_OWNER', count: 1 },
    ]);
    expect(result.scope.readable).toEqual([
      'platform:tenant:read',
      'platform:operations:read',
      'platform:support:read',
      'platform:audit:read',
    ]);
    expect(result.scope.writable).toEqual([]);
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.audit.overview_viewed',
    ]);
  });

  it('carries no per-operator identity in the role aggregation', async () => {
    const { service, store } = buildService();
    store.roleCounts = [{ role: 'AUDITOR', count: 1 }];

    const result = await service.overview(ACTOR);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toContain('userId');
  });
});

describe('AuditService organizations', () => {
  it('returns identity and status metadata only', async () => {
    const { service, store, audit } = buildService();
    store.organizations = [anOrganization()];

    const result = await service.organizations(ACTOR, {});

    expect(result.organizations).toEqual([
      {
        id: '20000000-0000-4000-8000-000000000001',
        name: 'Acme',
        slug: 'acme',
        status: 'ACTIVE',
        createdAt: NOW.toISOString(),
        memberCount: 3,
      },
    ]);
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.audit.organizations_viewed',
    ]);
  });

  it('never leaks billing, wallet or member fields', async () => {
    const { service, store } = buildService();
    // The store returns exactly its declared record; a field it does not
    // declare cannot appear. This asserts the response shape stays closed even
    // if the record type is later widened.
    store.organizations = [anOrganization()];

    const result = await service.organizations(ACTOR, {});

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/wallet|billing|balance|amountMinor|topUp/i);
  });

  it('pages at 50 and returns the last slug as the cursor', async () => {
    const { service, store } = buildService();
    store.organizations = Array.from({ length: 51 }, (_, index) =>
      anOrganization({ slug: `org-${`${index}`.padStart(3, '0')}`, id: `${index}`.padStart(36, '0') }),
    );

    const result = await service.organizations(ACTOR, {});

    expect(store.lastOrganizations).toEqual({ afterSlug: undefined, limit: 51 });
    expect(result.organizations).toHaveLength(50);
    expect(result.nextCursor).toBe('org-049');
  });

  it('returns a null cursor when nothing more exists', async () => {
    const { service, store } = buildService();
    store.organizations = [anOrganization()];

    const result = await service.organizations(ACTOR, {});

    expect(result.nextCursor).toBeNull();
  });

  it('passes an after-slug cursor through', async () => {
    const { service, store } = buildService();

    await service.organizations(ACTOR, { after: 'acme' });

    expect(store.lastOrganizations?.afterSlug).toBe('acme');
  });
});

describe('AuditService audit trail', () => {
  it('returns the stored organization identity without replacing it with metadata', async () => {
    const { service, store } = buildService();
    store.events = [anAuditEvent({
      trail: 'security', scope: 'PLATFORM', organizationId: 'stored-organization',
      metadata: { organizationId: 'legacy-metadata-organization', reasonCode: 'security_incident' },
    }), anAuditEvent()];
    const result = await service.auditTrail(ACTOR, {});
    expect(result.events[0]!.organizationId).toBe('stored-organization');
    expect(result.events[0]!.metadata).toMatchObject({ reasonCode: 'security_incident' });
    expect(result.events[1]!.organizationId).toBeNull();
  });

  it('pages at 50 and returns a trail-qualified cursor', async () => {
    const { service, store } = buildService();
    store.events = Array.from({ length: 51 }, (_, index) =>
      anAuditEvent({
        id: `${index + 1}`.padStart(36, '0'),
        trail: 'identity',
        occurredAt: new Date(NOW.getTime() + index),
      }),
    );

    const result = await service.auditTrail(ACTOR, {});

    expect(store.lastAudit).toEqual({ action: undefined, after: undefined, limit: 51 });
    expect(result.events).toHaveLength(50);
    expect(result.nextCursor).toBe(`identity:${'50'.padStart(36, '0')}`);
  });

  it('decodes a trail-qualified cursor back into a position', async () => {
    const { service, store } = buildService();
    const id = '10000000-0000-4000-8000-0000000000aa';

    await service.auditTrail(ACTOR, { cursor: `security:${id}` });

    expect(store.lastAudit?.after).toEqual({ trail: 'security', eventId: id });
  });

  it('passes a known action filter through and records only the fact of the read', async () => {
    const { service, store, audit } = buildService();

    await service.auditTrail(ACTOR, { action: 'platform.support.organization_viewed' });

    expect(store.lastAudit?.action).toBe('platform.support.organization_viewed');
    expect(audit.identityEvents[0]).toMatchObject({
      action: 'platform.audit.audit_viewed',
      metadata: { action: 'platform.support.organization_viewed' },
    });
  });

  it('rejects an unknown action filter', async () => {
    const { service } = buildService();

    await expectError(
      service.auditTrail(ACTOR, { action: 'made.up.action' }),
      BadRequestException,
      'invalid_action',
    );
  });

  it('rejects a cursor without a valid trail prefix', async () => {
    const { service } = buildService();

    await expectError(
      service.auditTrail(ACTOR, { cursor: '10000000-0000-4000-8000-000000000001' }),
      BadRequestException,
      'invalid_cursor',
    );
    await expectError(
      service.auditTrail(ACTOR, { cursor: 'organization:10000000-0000-4000-8000-000000000001' }),
      BadRequestException,
      'invalid_cursor',
    );
  });

  it('propagates a cursor-not-found from the store', async () => {
    const store = new FakeAuditorStore();
    store.platformAuditEvents = async () => {
      throw new NotFoundException({
        error: { code: 'audit_cursor_not_found', message: 'gone' },
      });
    };
    const service = new AuditService(store, new FakeAuditStore());

    await expectError(
      service.auditTrail(ACTOR, { cursor: 'identity:10000000-0000-4000-8000-000000000001' }),
      NotFoundException,
      'audit_cursor_not_found',
    );
  });
});

describe('AuditService sensitive evidence', () => {
  const uuid = '20000000-0000-4000-8000-000000000001';
  const walletEvent = anAuditEvent({
    trail: 'security',
    scope: 'PLATFORM',
    action: 'platform.billing.wallet_adjusted',
    targetType: 'wallet_entry',
    targetId: 'entry-1',
    metadata: {
      auditVersion: 1,
      target: { type: 'wallet_entry', id: 'entry-1' },
      before: { currency: 'UGX', balanceMinor: '1000', token: 'leak' },
      change: { currency: 'UGX', amountMinor: '500' },
      after: { currency: 'UGX', balanceMinor: '1500' },
      reasonCode: 'wallet_adjustment',
      justification: null,
      reasonSource: 'server',
    },
  });

  it('exposes bounded before/change/after evidence to a billing-authorized reader', async () => {
    const { service, store } = buildService();
    store.events = [walletEvent];

    const result = await service.auditTrail(ACTOR, {}, 'PLATFORM_OWNER');

    expect(result.events[0]!.evidence).toMatchObject({
      target: { type: 'wallet_entry', id: 'entry-1' },
      before: { currency: 'UGX', balanceMinor: '1000' },
      change: { currency: 'UGX', amountMinor: '500' },
      after: { currency: 'UGX', balanceMinor: '1500' },
      reasonCode: 'wallet_adjustment',
      reasonSource: 'server',
      financialAccess: 'visible',
      redacted: [],
    });
    // A credential-shaped key is dropped at read time even inside evidence.
    expect(result.events[0]!.evidence.before).not.toHaveProperty('token');
  });

  it.each(['AUDITOR', 'SUPPORT_ADMIN', 'TECHNICAL_ADMIN'] as const)(
    'redacts monetary evidence but keeps the record for %s',
    async (role) => {
      const { service, store } = buildService();
      store.events = [walletEvent];

      const result = await service.auditTrail(ACTOR, {}, role);
      const evidence = result.events[0]!.evidence;

      expect(evidence.before).toMatchObject({ currency: 'UGX', balanceMinor: '[redacted]' });
      expect(evidence.change).toMatchObject({ currency: 'UGX', amountMinor: '[redacted]' });
      expect(evidence.after).toMatchObject({ currency: 'UGX', balanceMinor: '[redacted]' });
      expect(evidence.financialAccess).toBe('redacted');
      expect(evidence.redacted).toEqual([
        'after.balanceMinor',
        'before.balanceMinor',
        'change.amountMinor',
      ]);
      // The event itself remains visible: redaction must not hide the action.
      expect(result.events[0]!.action).toBe('platform.billing.wallet_adjusted');
    },
  );

  it('keeps non-financial evidence visible to an auditor', async () => {
    const { service, store } = buildService();
    store.events = [
      anAuditEvent({
        trail: 'security',
        scope: 'PLATFORM',
        metadata: {
          target: { type: 'membership', id: uuid },
          before: { role: 'VIEWER' },
          change: { role: 'ADMIN' },
          after: { role: 'ADMIN' },
          reasonCode: 'membership_request',
          reasonSource: 'caller',
        },
      }),
    ];

    const result = await service.auditTrail(ACTOR, {}, 'AUDITOR');

    expect(result.events[0]!.evidence).toMatchObject({
      before: { role: 'VIEWER' },
      change: { role: 'ADMIN' },
      after: { role: 'ADMIN' },
      financialAccess: 'not_financial',
      redacted: [],
    });
  });

  it('passes every validated filter to the store and normalizes dates', async () => {
    const { service, store } = buildService();

    await service.auditTrail(
      ACTOR,
      {
        action: 'platform.support.organization_viewed',
        trail: 'security',
        outcome: 'DENIED',
        actor: 'ops@example.invalid',
        organizationId: uuid,
        targetId: 'campaign-1',
        from: '2026-10-01',
        to: '2026-10-31',
      },
      'AUDITOR',
    );

    expect(store.lastAudit).toMatchObject({
      action: 'platform.support.organization_viewed',
      trail: 'security',
      outcome: 'DENIED',
      actor: 'ops@example.invalid',
      organizationId: uuid,
      targetId: 'campaign-1',
      from: new Date('2026-10-01T00:00:00.000Z'),
      to: new Date('2026-10-31T23:59:59.999Z'),
    });
  });

  it.each([
    [{ outcome: 'MAYBE' }, 'invalid_outcome'],
    [{ trail: 'organization' }, 'invalid_trail'],
    [{ organizationId: 'not-a-uuid' }, 'invalid_filter'],
    [{ targetId: 'x'.repeat(65) }, 'invalid_filter'],
    [{ actor: 'wild%card' }, 'invalid_search'],
    [{ from: 'not-a-date' }, 'invalid_time_range'],
    [{ from: '2026-10-31', to: '2026-10-01' }, 'invalid_time_range'],
  ] as const)('rejects an invalid filter %o', async (query, code) => {
    const { service } = buildService();

    await expectError(service.auditTrail(ACTOR, query), BadRequestException, code);
  });
});

describe('AuditService metadata projection', () => {
  it('drops metadata keys outside the allowlist', async () => {
    const { service, store } = buildService();
    store.events = [
      anAuditEvent({
        metadata: {
          action: 'keep.me',
          permission: 'platform:audit:read',
          token: 'leak',
          passwordHash: 'leak',
          secret: 'leak',
        },
      }),
    ];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({
      action: 'keep.me',
      permission: 'platform:audit:read',
    });
    expect(JSON.stringify(result)).not.toMatch(/leak/);
  });

  it('drops non-object metadata entirely', async () => {
    const { service, store } = buildService();
    store.events = [anAuditEvent({ metadata: 'not-an-object' })];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({});
  });

  it('drops array metadata rather than passing it through', async () => {
    const { service, store } = buildService();
    store.events = [anAuditEvent({ metadata: ['a', 'b'] })];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({});
  });

  it('drops nested object and array values under a permitted key', async () => {
    // Key-allowlisting alone is not enough: `reason` is permitted, but a value
    // shaped like an object could carry a token the key denylist never sees.
    const { service, store } = buildService();
    store.events = [
      anAuditEvent({
        metadata: {
          reason: { token: 'leak', nested: { password: 'leak' } },
          outcome: ['SUCCESS'],
        },
      }),
    ];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({});
    expect(JSON.stringify(result)).not.toMatch(/leak/);
  });

  it('keeps only scalar values of an expected shape', async () => {
    const { service, store } = buildService();
    store.events = [
      anAuditEvent({
        metadata: {
          outcome: 'SUCCESS',
          count: 3,
          permission: true,
          reason: null,
        },
      }),
    ];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({
      outcome: 'SUCCESS',
      count: 3,
      permission: true,
      reason: null,
    });
  });

  it('drops an over-long string value rather than truncating it', async () => {
    const { service, store } = buildService();
    store.events = [
      anAuditEvent({ metadata: { reason: 'x'.repeat(257), outcome: 'SUCCESS' } }),
    ];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({ outcome: 'SUCCESS' });
  });

  it('drops a non-finite number, which is not a usable fact', async () => {
    const { service, store } = buildService();
    store.events = [anAuditEvent({ metadata: { count: Number.POSITIVE_INFINITY } })];

    const result = await service.auditTrail(ACTOR, {});

    expect(result.events[0]!.metadata).toEqual({});
  });
});

describe('AuditService is fail-closed', () => {
  it('propagates an audit-store failure instead of returning the data', async () => {
    const store = new FakeAuditorStore();
    store.events = [anAuditEvent()];
    const audit = new FakeAuditStore();
    audit.recordIdentity = async () => {
      throw new Error('audit unavailable');
    };
    const service = new AuditService(store, audit);

    await expect(service.auditTrail(ACTOR, {})).rejects.toThrow('audit unavailable');
  });

  it('refuses to write credential-shaped metadata', async () => {
    const store = new FakeAuditorStore();
    const audit = new FakeAuditStore();
    const service = new AuditService(store, audit);

    await expect(
      (
        service as unknown as {
          recordIdentityEvent(
            actor: string,
            action: string,
            metadata: Record<string, unknown>,
          ): Promise<void>;
        }
      ).recordIdentityEvent(ACTOR, 'platform.audit.overview_viewed', { token: 'secret' }),
    ).rejects.toThrow(/credential-shaped/);
  });
});
