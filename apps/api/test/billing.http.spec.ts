import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, ORGANIZATION_ROLE_PERMISSIONS, type OrganizationRole } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingController } from '../src/billing/billing.controller.js';
import { BillingService } from '../src/billing/billing.service.js';
import { BILLING_STORE } from '../src/billing/billing.store.js';
import { CampaignsController } from '../src/campaigns/campaigns.controller.js';
import { CampaignsService } from '../src/campaigns/campaigns.service.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { OrganizationGuard } from '../src/auth/organization.guard.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import {
  AUTH_STORE,
  AUDIT_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  TERMS_VERSION,
} from '../src/auth/tokens.js';
import {
  FakeAuthStore,
  FakeAuditStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aUser,
  aMembership,
} from './fakes/auth.fakes.js';
import { FakeBillingStore } from './fakes/billing.fakes.js';

/** Real HTTP, session/terms/CSRF/tenant guards and service; persistence is an explicit fake. */
describe('RBAC-004 authenticated billing HTTP journey', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let store: FakeBillingStore;
  const csrf = 'a'.repeat(64);
  const campaignUpdate = vi.fn();
  const campaignStatusReport = vi.fn();
  beforeEach(async () => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    store = new FakeBillingStore();
    auth.users.push(aUser({ id: 'user-1' }));
    await auth.createSession({
      id: randomUUID(),
      userId: 'user-1',
      tokenHash: hashToken('billing-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600000),
      userAgentHash: null,
      ipPrefix: null,
    });
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    organizations.memberships.push(
      aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'BILLING' }),
    );
    const module = await Test.createTestingModule({
      controllers: [BillingController, CampaignsController],
      providers: [
        BillingService,
        SessionGuard,
        OrganizationGuard,
        CsrfGuard,
        { provide: BILLING_STORE, useValue: store },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: AUDIT_STORE, useValue: new FakeAuditStore() },
        { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        {
          provide: CampaignsService,
          useValue: { update: campaignUpdate, statusReport: campaignStatusReport },
        },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    campaignUpdate.mockClear();
    campaignStatusReport.mockResolvedValue({ total: 2, draft: 1, active: 1, completed: 0 });
  });
  afterEach(async () => {
    await app?.close();
  });
  function call(method: 'get' | 'post' | 'patch', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=billing-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf);
  }
  it('reads wallet/history, saves billing, and records a retry-safe pending top-up', async () => {
    const root = '/organizations/org-1';
    expect((await call('get', `${root}/wallet`)).body).toEqual({
      currency: 'UGX',
      amountMinor: '0',
    });
    expect((await call('get', `${root}/wallet/transactions`)).body.entries).toEqual([]);
    expect(
      (
        await call('patch', `${root}/billing`).send({
          name: 'Billing customer',
          email: 'billing@example.com',
          address: 'Kampala',
          organizationId: 'other',
        })
      ).status,
    ).toBe(200);
    const body = { amountMinor: '50000', currency: 'UGX', idempotencyKey: randomUUID() };
    const first = await call('post', `${root}/wallet/top-ups`).send(body);
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('PENDING');
    expect((await call('post', `${root}/wallet/top-ups`).send(body)).body.id).toBe(first.body.id);
    const billing = await call('get', `${root}/billing`);
    expect(billing.body.profile.name).toBe('Billing customer');
    expect(billing.body.topUps).toHaveLength(1);
    expect((await call('get', `${root}/wallet`)).body.amountMinor).toBe('0');
  });
  it.each<OrganizationRole>(['ADMIN', 'CAMPAIGN_MANAGER', 'VIEWER'])(
    'denies billing resources for %s',
    async (role) => {
      organizations.memberships[0]!.role = role;
      for (const path of ['wallet', 'wallet/transactions', 'billing'])
        expect((await call('get', `/organizations/org-1/${path}`)).status).toBe(403);
      expect((await call('post', '/organizations/org-1/wallet/top-ups').send({})).status).toBe(403);
      expect((await call('patch', '/organizations/org-1/billing').send({})).status).toBe(403);
    },
  );
  it('permits owner billing and revokes billing access immediately after a role change', async () => {
    organizations.memberships[0]!.role = 'OWNER';
    expect((await call('get', '/organizations/org-1/billing')).status).toBe(200);
    organizations.memberships[0]!.role = 'VIEWER';
    expect((await call('get', '/organizations/org-1/billing')).status).toBe(403);
  });
  it('prevents foreign-tenant reads and writes even with a billing role elsewhere', async () => {
    for (const path of ['wallet', 'wallet/transactions', 'billing'])
      expect((await call('get', `/organizations/other/${path}`)).status).toBe(403);
    expect((await call('post', '/organizations/other/wallet/top-ups').send({})).status).toBe(403);
    expect((await call('patch', '/organizations/other/billing').send({})).status).toBe(403);
    expect(store.requests).toHaveLength(0);
    expect(store.profiles.size).toBe(0);
  });
  it('denies campaign launch through the actual status update route', async () => {
    expect(
      (await call('patch', '/organizations/org-1/campaigns/campaign').send({ status: 'ACTIVE' }))
        .status,
    ).toBe(403);
    expect(campaignUpdate).not.toHaveBeenCalled();
    expect(
      ORGANIZATION_ROLE_PERMISSIONS.BILLING.some(
        (permission) => permission.startsWith('campaign:') || permission.startsWith('contact:'),
      ),
    ).toBe(false);
    // Contacts are not implemented; absence is not claimed as a future authorization mechanism.
    expect(
      (await call('patch', '/organizations/org-1/contacts/contact').send({ name: 'forbidden' }))
        .status,
    ).toBe(404);
  });
  it('allows Viewer report reads while campaign and billing changes remain forbidden', async () => {
    organizations.memberships[0]!.role = 'VIEWER';
    const report = await call('get', '/organizations/org-1/reports/campaign-status');
    expect(report.status).toBe(200);
    expect(report.body).toEqual({ total: 2, draft: 1, active: 1, completed: 0 });
    expect(campaignStatusReport).toHaveBeenCalledWith('org-1');
    expect((await call('post', '/organizations/org-1/campaigns').send({ name: 'No' })).status).toBe(
      403,
    );
    expect((await call('patch', '/organizations/org-1/billing').send({ name: 'No' })).status).toBe(
      403,
    );
  });
  it('requires a session, accepted terms, active tenant, and CSRF on money requests', async () => {
    expect((await request(app.getHttpServer()).get('/organizations/org-1/wallet')).status).toBe(
      401,
    );
    auth.terms = [];
    expect((await call('get', '/organizations/org-1/billing')).status).toBe(403);
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    expect(
      (
        await request(app.getHttpServer())
          .post('/organizations/org-1/wallet/top-ups')
          .set('cookie', 'tv_session=billing-session')
          .send({})
      ).status,
    ).toBe(403);
    organizations.organizations[0]!.suspendedAt = new Date();
    expect((await call('get', '/organizations/org-1/wallet')).status).toBe(403);
    expect(store.requests).toHaveLength(0);
  });
});
