import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { OrganizationGuard, PlatformGuard } from '../src/auth/organization.guard.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { CampaignsController } from '../src/campaigns/campaigns.controller.js';
import { CampaignsService } from '../src/campaigns/campaigns.service.js';
import { CAMPAIGN_STORE } from '../src/campaigns/tokens.js';
import type { CampaignRecord, CampaignStore } from '../src/campaigns/campaign.store.js';
import { ContactsService } from '../src/contacts/contacts.service.js';
import {
  AUTH_STORE,
  AUDIT_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  TERMS_VERSION,
  RATE_LIMITER,
} from '../src/auth/tokens.js';
import { OrganizationsController } from '../src/organizations/organizations.controller.js';
import { OrganizationsService } from '../src/organizations/organizations.service.js';
import { OperationsController } from '../src/operations/operations.controller.js';
import { OperationsService } from '../src/operations/operations.service.js';
import { TechnicalController } from '../src/technical/technical.controller.js';
import { TechnicalService } from '../src/technical/technical.service.js';
import { TechnicalRateLimitGuard } from '../src/technical/technical-rate-limit.guard.js';
import { AuditController } from '../src/audit/audit.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditRateLimitGuard } from '../src/audit/audit-rate-limit.guard.js';
import { SupportController } from '../src/support/support.controller.js';
import { SupportService } from '../src/support/support.service.js';
import { SupportAccessService } from '../src/support/support-access.service.js';
import {
  SUPPORT_ACCESS_STORE,
  type SupportAccessStore,
} from '../src/support/support-access.store.js';
import { SupportAccessGuard } from '../src/support/support-access.guard.js';
import { SupportRateLimitGuard } from '../src/support/support-rate-limit.guard.js';
import {
  FakeAuthStore,
  FakeAuditStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aUser,
  aMembership,
  aSession,
} from './fakes/auth.fakes.js';

// Real controllers and guards; every business operation is a spy, with no database or provider.
describe('RBAC-003 Campaign Manager prohibited administration over HTTP', () => {
  let app: INestApplication;
  let organizations: FakeOrganizationStore;
  const csrf = 'a'.repeat(64);
  let campaigns: CampaignRecord[];
  const campaignStore = {
    createCampaign: vi.fn<CampaignStore['createCampaign']>(),
    listCampaigns: vi.fn<CampaignStore['listCampaigns']>(),
    findCampaign: vi.fn<CampaignStore['findCampaign']>(),
    updateCampaign: vi.fn<CampaignStore['updateCampaign']>(),
    deleteCampaign: vi.fn<CampaignStore['deleteCampaign']>(),
  } satisfies CampaignStore;
  const accessStore = {
    create: vi.fn<SupportAccessStore['create']>(),
    resolve: vi.fn<SupportAccessStore['resolve']>(),
    revoke: vi.fn<SupportAccessStore['revoke']>(),
  } satisfies SupportAccessStore;
  const business = {
    getProfile: vi.fn().mockResolvedValue({ id: 'org-1' }),
    updateProfile: vi.fn(),
    listMembers: vi.fn(),
    changeMemberRole: vi.fn(),
    removeMember: vi.fn(),
    listInvitations: vi.fn(),
    invite: vi.fn(),
    revokeInvitation: vi.fn(),
    transferOwnership: vi.fn(),
    operatorContext: vi.fn(),
    listOrganizations: vi.fn(),
    listCampaigns: vi.fn(),
    healthReport: vi.fn(),
    emergencyStop: vi.fn(),
    overview: vi.fn(),
    providers: vi.fn(),
    queues: vi.fn(),
    logs: vi.fn(),
    auditTrail: vi.fn(),
    organizations: vi.fn(),
    searchOrganizations: vi.fn(),
    organization: vi.fn(),
    diagnostics: vi.fn(),
    organizationAudit: vi.fn(),
    searchUsers: vi.fn(),
    user: vi.fn(),
    userAudit: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    campaigns = [];
    campaignStore.createCampaign.mockImplementation(async (input) => {
      const row = { ...input, createdAt: new Date(), updatedAt: new Date() };
      campaigns.push(row);
      return row;
    });
    campaignStore.listCampaigns.mockImplementation(async (org) =>
      campaigns.filter((row) => row.organizationId === org),
    );
    campaignStore.findCampaign.mockImplementation(async (org, id) =>
      campaigns.find((row) => row.organizationId === org && row.id === id),
    );
    campaignStore.updateCampaign.mockImplementation(async (org, id, changes) => {
      const row = campaigns.find((row) => row.organizationId === org && row.id === id);
      if (!row) return undefined;
      const updated = { ...row, ...changes };
      campaigns[campaigns.indexOf(row)] = updated;
      return updated;
    });
    campaignStore.deleteCampaign.mockImplementation(async (org, id) => {
      const index = campaigns.findIndex((row) => row.organizationId === org && row.id === id);
      if (index < 0) return false;
      campaigns.splice(index, 1);
      return true;
    });
    const auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    auth.users.push(aUser({ id: 'user-1', email: 'manager@example.test' }));
    await auth.createSession(
      aSession({ userId: 'user-1', tokenHash: hashToken('manager-session') }),
    );
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    organizations.memberships.push(
      aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'CAMPAIGN_MANAGER' }),
    );
    const module = await Test.createTestingModule({
      controllers: [
        OrganizationsController,
        OperationsController,
        TechnicalController,
        AuditController,
        SupportController,
        CampaignsController,
      ],
      providers: [
        SessionGuard,
        OrganizationGuard,
        PlatformGuard,
        CsrfGuard,
        TechnicalRateLimitGuard,
        AuditRateLimitGuard,
        SupportRateLimitGuard,
        SupportAccessGuard,
        ...[
          OrganizationsService,
          OperationsService,
          TechnicalService,
          AuditService,
          SupportService,
        ].map((provide) => ({ provide, useValue: business })),
        SupportAccessService,
        { provide: SUPPORT_ACCESS_STORE, useValue: accessStore },
        CampaignsService,
        { provide: CAMPAIGN_STORE, useValue: campaignStore },
        {
          provide: ContactsService,
          useValue: { countEligibleForCampaign: vi.fn().mockResolvedValue(0) },
        },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
        { provide: AUDIT_STORE, useValue: new FakeAuditStore() },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        {
          provide: RATE_LIMITER,
          useValue: { consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) },
        },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  function call(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=manager-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf);
  }
  const tenantDenials = [
    ['get', '/members', {}],
    ['patch', '/members/owner', { role: 'VIEWER' }],
    ['delete', '/members/owner', {}],
    ['patch', '/members/peer', { role: 'OWNER' }],
    ['delete', '/members/peer', {}],
    ['get', '/invitations', {}],
    ['post', '/invitations', { email: 'invitee@example.test', role: 'VIEWER' }],
    ['delete', '/invitations/invitation', {}],
    ['post', '/ownership/transfer', { newOwnerId: 'peer' }],
    ['patch', '', { name: 'Forbidden rename' }],
  ] as const;
  it.each(tenantDenials)(
    'denies %s %s with permission_denied and no business operation',
    async (method, suffix, body) => {
      const before = structuredClone(organizations.memberships);
      const response = await call(method, '/organizations/org-1' + suffix).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('permission_denied');
      for (const operation of Object.values(business)) expect(operation).not.toHaveBeenCalled();
      expect(organizations.memberships).toEqual(before);
    },
  );
  const platformReads = [
    '/platform/operations/me',
    '/platform/operations/organizations',
    '/platform/operations/campaigns',
    '/platform/operations/health',
    ...['me', 'overview', 'providers', 'queues', 'logs', 'audit'].map(
      (p) => '/platform/technical/' + p,
    ),
    ...['me', 'overview', 'organizations', 'audit'].map((p) => '/platform/audit/' + p),
    ...[
      'me',
      'organizations',
      'organizations/org-1',
      'organizations/org-1/audit',
      'users',
      'users/user-1',
      'users/user-1/audit',
    ].map((p) => '/platform/support/' + p),
  ];
  it.each(platformReads)(
    'denies implemented platform GET %s before business access',
    async (path) => {
      const response = await call('get', path);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('permission_denied');
      for (const operation of Object.values(business)) expect(operation).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      '/platform/operations/organizations/org-1/campaigns/campaign/emergency-stop',
      { reasonCode: 'abuse_suspected' },
    ],
    ['/platform/support/sessions', { organizationId: 'org-1', reasonCode: 'customer_request' }],
    ['/platform/support/sessions/terminate', {}],
  ])('denies implemented platform mutation %s', async (path, body) => {
    const response = await call('post', path).send(body);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    for (const operation of Object.values(business)) expect(operation).not.toHaveBeenCalled();
    expect(accessStore.create).not.toHaveBeenCalled();
    expect(accessStore.revoke).not.toHaveBeenCalled();
  });
  it('refuses platform support diagnostics without a support session', async () => {
    const response = await call('get', '/platform/support/organizations/org-1/diagnostics');
    expect(response.status).toBe(403);
    // This route uses the dedicated support-context refusal, rather than permission_denied.
    expect(business.diagnostics).not.toHaveBeenCalled();
    for (const operation of Object.values(accessStore)) expect(operation).not.toHaveBeenCalled();
  });
  it('allows own organization discovery but refuses a foreign organization', async () => {
    expect((await call('get', '/organizations/org-1')).status).toBe(200);
    expect(business.getProfile).toHaveBeenCalledWith('org-1');
    business.getProfile.mockClear();
    const response = await call('get', '/organizations/foreign');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    expect(business.getProfile).not.toHaveBeenCalled();
  });
  it('allows Campaign Manager draft CRUD, preflight and reporting without enabling execution', async () => {
    const root = '/organizations/org-1/campaigns';
    const created = await call('post', root).send({
      name: 'Synthetic draft',
      organizationId: 'foreign',
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('DRAFT');
    expect(campaigns[0]).toMatchObject({ organizationId: 'org-1', createdById: 'user-1' });
    const item = root + '/' + created.body.id;
    expect((await call('get', root)).status).toBe(200);
    expect((await call('get', item)).status).toBe(200);
    expect((await call('patch', item).send({ name: 'Renamed draft' })).status).toBe(200);
    const preflight = await call('post', item + '/preflight').send({});
    expect(preflight.status).toBe(200);
    expect(preflight.body.valid).toBe(false);
    expect((await call('get', '/organizations/org-1/reports/campaign-status')).status).toBe(200);
    const activation = await call('patch', item).send({ status: 'ACTIVE' });
    expect(activation.status).toBe(400);
    expect(campaigns[0]!.status).toBe('DRAFT');
    expect((await call('delete', item)).status).toBe(204);
    expect(campaigns).toEqual([]);
  });
  it.each([
    ['get', '/campaigns'],
    ['post', '/campaigns'],
    ['get', '/campaigns/foreign-id'],
    ['patch', '/campaigns/foreign-id'],
    ['delete', '/campaigns/foreign-id'],
    ['post', '/campaigns/foreign-id/preflight'],
    ['get', '/reports/campaign-status'],
  ] as const)(
    'refuses Campaign Manager foreign-organization campaign %s %s',
    async (method, suffix) => {
      const response = await call(method, '/organizations/foreign' + suffix).send({
        name: 'Synthetic',
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('permission_denied');
      for (const operation of Object.values(campaignStore))
        expect(operation).not.toHaveBeenCalled();
      expect(campaigns).toEqual([]);
    },
  );
});
