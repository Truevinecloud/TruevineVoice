/**
 * Unit tests for the support service (RBAC-009).
 *
 * Backed by an in-memory fake, not PostgreSQL, as AGENTS.md 13 requires. The
 * fake records every input it was handed, so "was the search query kept out of
 * the audit trail?" is an assertion rather than a comment. The E2E suite
 * repeats the same behaviour against real PostgreSQL.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AuditEventInput, IdentityAuditEventInput } from '../auth/auth.store.js';
import { FakeAuditStore } from '../../test/fakes/auth.fakes.js';

import type {
  OrganizationDiagnosticsRecord,
  SupportAuditEventRecord,
  SupportAuditTrailInput,
  SupportMemberRecord,
  SupportMembershipRecord,
  SupportOrganizationDetail,
  SupportOrganizationSearchInput,
  SupportOrganizationSummary,
  SupportSessionSummary,
  SupportStore,
  SupportUserDetail,
  SupportUserSearchInput,
  SupportUserSummary,
} from './support.store.js';
import { SupportService } from './support.service.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '00000000-0000-4000-8000-000000000002';
const ACTOR = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-10-20T00:00:00Z');

class FakeSupportStore implements SupportStore {
  lastOrganizationSearch?: SupportOrganizationSearchInput;
  lastUserSearch?: SupportUserSearchInput;
  lastOrganizationAudit?: SupportAuditTrailInput;
  lastUserAudit?: SupportAuditTrailInput;
  organizationSummaries: SupportOrganizationSummary[] = [];
  organizationDetail?: SupportOrganizationDetail;
  members: SupportMemberRecord[] = [];
  diagnosticsRecord?: OrganizationDiagnosticsRecord;
  userSummaries: SupportUserSummary[] = [];
  userDetail?: SupportUserDetail;
  userMemberships: SupportMembershipRecord[] = [];
  sessions: SupportSessionSummary = { active: 0, revoked: 0, expired: 0, lastUsedAt: null };
  organizationEvents: SupportAuditEventRecord[] = [];
  userEvents: SupportAuditEventRecord[] = [];

  async searchOrganizations(
    input: SupportOrganizationSearchInput,
  ): Promise<readonly SupportOrganizationSummary[]> {
    this.lastOrganizationSearch = input;
    return this.organizationSummaries;
  }

  async findOrganizationDetail(): Promise<SupportOrganizationDetail | undefined> {
    return this.organizationDetail;
  }

  async listMembers(): Promise<readonly SupportMemberRecord[]> {
    return this.members;
  }

  async diagnostics(): Promise<OrganizationDiagnosticsRecord | undefined> {
    return this.diagnosticsRecord;
  }

  async searchUsers(input: SupportUserSearchInput): Promise<readonly SupportUserSummary[]> {
    this.lastUserSearch = input;
    return this.userSummaries;
  }

  async findUserDetail(): Promise<SupportUserDetail | undefined> {
    return this.userDetail;
  }

  async listUserMemberships(): Promise<readonly SupportMembershipRecord[]> {
    return this.userMemberships;
  }

  async sessionSummary(): Promise<SupportSessionSummary> {
    return this.sessions;
  }

  async organizationAuditEvents(
    _organizationId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]> {
    this.lastOrganizationAudit = input;
    return this.organizationEvents;
  }

  async userAuditEvents(
    _userId: string,
    input: SupportAuditTrailInput,
  ): Promise<readonly SupportAuditEventRecord[]> {
    this.lastUserAudit = input;
    return this.userEvents;
  }
}

function anOrganizationSummary(
  overrides: Partial<SupportOrganizationSummary> = {},
): SupportOrganizationSummary {
  return {
    id: ORG_ID,
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    createdAt: NOW,
    memberCount: 1,
    campaignCount: 0,
    ...overrides,
  };
}

function anOrganizationDetail(
  overrides: Partial<SupportOrganizationDetail> = {},
): SupportOrganizationDetail {
  return {
    ...anOrganizationSummary(),
    suspendedAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function aUserSummary(overrides: Partial<SupportUserSummary> = {}): SupportUserSummary {
  return {
    id: USER_ID,
    email: 'person@example.invalid',
    status: 'ACTIVE',
    createdAt: NOW,
    lockedUntil: null,
    platformRole: null,
    membershipCount: 1,
    ...overrides,
  };
}

function aUserDetail(overrides: Partial<SupportUserDetail> = {}): SupportUserDetail {
  return {
    ...aUserSummary(),
    failedLoginCount: 0,
    passwordChangedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function diagnosticsRecord(
  overrides: Partial<OrganizationDiagnosticsRecord> = {},
): OrganizationDiagnosticsRecord {
  return {
    memberCount: 1,
    auditEventCount: 2,
    billingProfilePresent: false,
    campaigns: { total: 0, byStatus: {}, emergencyStoppedCount: 0, recent: [] },
    walletBalances: [],
    topUpRequests: [],
    ...overrides,
  };
}

function anAuditEvent(overrides: Partial<SupportAuditEventRecord> = {}): SupportAuditEventRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    action: 'auth.sign_in.succeeded',
    outcome: 'SUCCESS',
    scope: null,
    targetType: null,
    targetId: null,
    occurredAt: NOW,
    actorUserId: USER_ID,
    actorEmail: 'person@example.invalid',
    metadata: {},
    ...overrides,
  };
}

function buildService(): {
  service: SupportService;
  store: FakeSupportStore;
  audit: FakeAuditStore;
} {
  const store = new FakeSupportStore();
  const audit = new FakeAuditStore();
  return { service: new SupportService(store, audit), store, audit };
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
    expect((error as { getResponse(): unknown }).getResponse()).toMatchObject({
      error: { code },
    });
  }
}

function metadataOf(event: AuditEventInput | IdentityAuditEventInput): unknown {
  return event.metadata;
}

describe('SupportService organization search', () => {
  it('passes filters through, pages at 50, and returns a slug cursor', async () => {
    const { service, store } = buildService();
    store.organizationSummaries = Array.from({ length: 51 }, (_, index) =>
      anOrganizationSummary({ slug: `org-${String(index).padStart(2, '0')}` }),
    );

    const result = await service.searchOrganizations(ACTOR, {
      q: 'acme',
      status: 'ACTIVE',
    });

    expect(store.lastOrganizationSearch).toEqual({
      query: 'acme',
      status: 'ACTIVE',
      afterSlug: undefined,
      limit: 51,
    });
    expect(result.organizations).toHaveLength(50);
    expect(result.nextCursor).toBe('org-49');
  });

  it('returns a null cursor when nothing more exists', async () => {
    const { service, store } = buildService();
    store.organizationSummaries = [anOrganizationSummary()];

    const result = await service.searchOrganizations(ACTOR, {});

    expect(store.lastOrganizationSearch?.query).toBeUndefined();
    expect(result.nextCursor).toBeNull();
  });

  it('records the search on the identity trail without the query string', async () => {
    const { service, audit } = buildService();

    await service.searchOrganizations(ACTOR, { q: 'secret-customer-name' });

    expect(audit.actions()).toEqual(['platform.support.organization_searched']);
    expect(JSON.stringify(metadataOf(audit.identityEvents[0]!))).not.toContain(
      'secret-customer-name',
    );
  });

  it('records a non-sensitive status filter in the audit metadata', async () => {
    const { service, audit } = buildService();

    await service.searchOrganizations(ACTOR, { status: 'SUSPENDED' });

    expect(metadataOf(audit.identityEvents[0]!)).toEqual({ status: 'SUSPENDED' });
  });

  it('rejects an unknown status filter', async () => {
    const { service } = buildService();

    await expectError(
      service.searchOrganizations(ACTOR, { status: 'DELETED' }),
      BadRequestException,
      'invalid_status',
    );
  });

  it('rejects wildcard characters in the query', async () => {
    const { service } = buildService();

    await expectError(
      service.searchOrganizations(ACTOR, { q: '%acme' }),
      BadRequestException,
      'invalid_query',
    );
  });
});

describe('SupportService user search', () => {
  it('requires at least three characters', async () => {
    const { service } = buildService();

    await expectError(service.searchUsers(ACTOR, {}), BadRequestException, 'invalid_query');
    await expectError(service.searchUsers(ACTOR, { q: 'ab' }), BadRequestException, 'invalid_query');
  });

  it('passes the query and email cursor through and never records the query', async () => {
    const { service, store, audit } = buildService();
    store.userSummaries = [aUserSummary()];

    const result = await service.searchUsers(ACTOR, {
      q: 'alice@example.invalid',
      cursor: 'a@example.invalid',
    });

    expect(store.lastUserSearch).toEqual({
      query: 'alice@example.invalid',
      afterEmail: 'a@example.invalid',
      limit: 51,
    });
    expect(result.users).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
    expect(JSON.stringify(audit.identityEvents)).not.toContain('alice@example.invalid');
  });

  it('rejects a cursor that is not an email', async () => {
    const { service } = buildService();

    await expectError(
      service.searchUsers(ACTOR, { q: 'alice', cursor: 'not-an-email' }),
      BadRequestException,
      'invalid_cursor',
    );
  });
});

describe('SupportService organization detail and diagnostics', () => {
  it('rejects a malformed organization id before touching the store', async () => {
    const { service } = buildService();

    await expectError(service.organization(ACTOR, 'nope'), BadRequestException, 'invalid_request');
  });

  it('404s for an unknown organization', async () => {
    const { service, audit } = buildService();

    await expectError(service.organization(ACTOR, ORG_ID), NotFoundException);
    expect(audit.actions()).toEqual([]);
  });

  it('returns the organization with members and records the view', async () => {
    const { service, store, audit } = buildService();
    store.organizationDetail = anOrganizationDetail();
    store.members = [
      {
        userId: USER_ID,
        email: 'owner@example.invalid',
        userStatus: 'ACTIVE',
        role: 'OWNER',
        joinedAt: NOW,
        lockedUntil: null,
      },
    ];

    const result = await service.organization(ACTOR, ORG_ID);

    expect(result.organization.slug).toBe('acme');
    expect(result.members).toEqual([
      {
        userId: USER_ID,
        email: 'owner@example.invalid',
        userStatus: 'ACTIVE',
        role: 'OWNER',
        joinedAt: NOW.toISOString(),
        lockedUntil: null,
      },
    ]);
    expect(audit.events).toEqual([
      {
        organizationId: ORG_ID,
        actorUserId: ACTOR,
        action: 'platform.support.organization_viewed',
        scope: 'PLATFORM',
        outcome: 'SUCCESS',
        targetType: 'organization',
        targetId: ORG_ID,
        metadata: {},
      },
    ]);
  });

  it('returns diagnostics with ledger totals as strings and names unavailable domains', async () => {
    const { service, store, audit } = buildService();
    store.organizationDetail = anOrganizationDetail();
    store.diagnosticsRecord = diagnosticsRecord({
      walletBalances: [
        { currency: 'UGX', amountMinor: 5_000n, entryCount: 3, lastEntryAt: NOW },
      ],
      topUpRequests: [
        {
          currency: 'UGX',
          requestCount: 1,
          totalRequestedMinor: 10_000n,
          lastRequestedAt: NOW,
        },
      ],
      billingProfilePresent: true,
    });

    const result = await service.diagnostics(ACTOR, ORG_ID);

    expect(result.walletBalances).toEqual([
      {
        currency: 'UGX',
        amountMinor: '5000',
        entryCount: 3,
        lastEntryAt: NOW.toISOString(),
      },
    ]);
    expect(result.topUpRequests?.[0]?.totalRequestedMinor).toBe('10000');
    expect(result.billingProfilePresent).toBe(true);
    expect(result.notAvailable).toContain('voice_calls');
    expect(audit.actions()).toEqual(['platform.support.diagnostics_viewed']);
  });
});

describe('SupportService user detail', () => {
  it('404s for an unknown user and writes no audit row', async () => {
    const { service, audit } = buildService();

    await expectError(service.user(ACTOR, USER_ID), NotFoundException);
    expect(audit.actions()).toEqual([]);
  });

  it('returns the user with memberships and session summary, and records the view', async () => {
    const { service, store, audit } = buildService();
    store.userDetail = aUserDetail({
      lockedUntil: NOW,
      platformRole: { role: 'SUPPORT_ADMIN', grantedAt: NOW },
    });
    store.userMemberships = [
      {
        organizationId: ORG_ID,
        organizationName: 'Acme',
        organizationSlug: 'acme',
        role: 'ADMIN',
        joinedAt: NOW,
      },
    ];
    store.sessions = { active: 2, revoked: 1, expired: 3, lastUsedAt: NOW };

    const result = await service.user(ACTOR, USER_ID);

    expect(result.user.email).toBe('person@example.invalid');
    expect(result.user.platformRole).toEqual({
      role: 'SUPPORT_ADMIN',
      grantedAt: NOW.toISOString(),
    });
    expect(result.memberships).toHaveLength(1);
    expect(result.sessionSummary).toEqual({
      active: 2,
      revoked: 1,
      expired: 3,
      lastUsedAt: NOW.toISOString(),
    });
    expect(audit.identityEvents).toEqual([
      {
        actorUserId: ACTOR,
        action: 'platform.support.user_viewed',
        outcome: 'SUCCESS',
        metadata: { targetUserId: USER_ID },
      },
    ]);
  });
});

describe('SupportService audit trails', () => {
  it('rejects an unknown action filter', async () => {
    const { service, store } = buildService();
    store.organizationDetail = anOrganizationDetail();

    await expectError(
      service.organizationAudit(ACTOR, ORG_ID, { action: 'made.up.action' }),
      BadRequestException,
      'invalid_action',
    );
  });

  it('rejects a malformed cursor', async () => {
    const { service, store } = buildService();
    store.organizationDetail = anOrganizationDetail();

    await expectError(
      service.organizationAudit(ACTOR, ORG_ID, { cursor: 'oops' }),
      BadRequestException,
      'invalid_cursor',
    );
  });

  it('reads the organization trail and records that it was read', async () => {
    const { service, store, audit } = buildService();
    store.organizationDetail = anOrganizationDetail();
    store.organizationEvents = [
      anAuditEvent({
        scope: 'PLATFORM',
        action: 'platform.support.organization_viewed',
        actorEmail: 'support@example.invalid',
      }),
    ];

    const result = await service.organizationAudit(ACTOR, ORG_ID, {
      action: 'platform.support.organization_viewed',
    });

    expect(store.lastOrganizationAudit?.action).toBe('platform.support.organization_viewed');
    expect(result.events[0]?.actor).toEqual({
      userId: USER_ID,
      email: 'support@example.invalid',
    });
    expect(audit.events[0]?.action).toBe('platform.support.audit_viewed');
    expect(audit.events[0]?.metadata).toEqual({ action: 'platform.support.organization_viewed' });
  });

  it('reads the user identity trail and records that it was read', async () => {
    const { service, store, audit } = buildService();
    store.userDetail = aUserDetail();
    store.userEvents = [anAuditEvent()];

    const result = await service.userAudit(ACTOR, USER_ID, {});

    expect(result.events).toHaveLength(1);
    expect(store.lastUserAudit?.action).toBeUndefined();
    expect(audit.identityEvents[0]).toMatchObject({
      action: 'platform.support.audit_viewed',
      metadata: { targetUserId: USER_ID },
    });
  });

  it('pages with the returned event id as the next cursor', async () => {
    const { service, store } = buildService();
    store.organizationDetail = anOrganizationDetail();
    store.organizationEvents = Array.from({ length: 51 }, (_, index) =>
      anAuditEvent({ id: `${index}`.padStart(36, '0'), occurredAt: new Date(NOW.getTime() + index) }),
    );

    const result = await service.organizationAudit(ACTOR, ORG_ID, {});

    expect(result.events).toHaveLength(50);
    expect(result.nextCursor).toBe('49'.padStart(36, '0'));
  });
});

describe('SupportService audit is fail-closed', () => {
  it('propagates an audit-store failure instead of returning the data', async () => {
    const store = new FakeSupportStore();
    store.organizationSummaries = [anOrganizationSummary()];
    const audit = new FakeAuditStore();
    audit.recordIdentity = async () => {
      throw new Error('audit unavailable');
    };
    const service = new SupportService(store, audit);

    await expect(service.searchOrganizations(ACTOR, {})).rejects.toThrow('audit unavailable');
  });
});
