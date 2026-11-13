import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, type PlatformRole } from '@truevine/auth';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { OrganizationGuard, PlatformGuard } from '../src/auth/organization.guard.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import {
  AUDIT_STORE,
  AUTH_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  RATE_LIMITER,
  TERMS_VERSION,
} from '../src/auth/tokens.js';
import { AuditController } from '../src/audit/audit.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditRateLimitGuard } from '../src/audit/audit-rate-limit.guard.js';
import { BillingController } from '../src/billing/billing.controller.js';
import { BillingService } from '../src/billing/billing.service.js';
import { BillingAdminController } from '../src/billing-admin/billing-admin.controller.js';
import { BillingAdminService } from '../src/billing-admin/billing-admin.service.js';
import { PlatformAdminController } from '../src/platform-admin/platform-admin.controller.js';
import { PlatformAdminService } from '../src/platform-admin/platform-admin.service.js';
import { HealthService } from '../src/health/health.service.js';
import { TechnicalController } from '../src/technical/technical.controller.js';
import { TechnicalService } from '../src/technical/technical.service.js';
import { TechnicalRateLimitGuard } from '../src/technical/technical-rate-limit.guard.js';
import { TECHNICAL_STORE } from '../src/technical/tokens.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aUser,
} from './fakes/auth.fakes.js';

describe('Technical Admin HTTP security boundary', () => {
  let app: INestApplication;
  let roles: FakePlatformRoleStore;
  let audit: FakeAuditStore;
  const platformAuditEvents = vi.fn(async (_input: unknown) => [
    {
      id: randomUUID(),
      trail: 'identity',
      action: 'platform.technical.overview_viewed',
      outcome: 'SUCCESS',
      scope: null,
      targetType: null,
      targetId: 'customer-id',
      occurredAt: new Date('2026-11-12T00:00:00Z'),
      actorUserId: 'customer-id',
      actorEmail: 'private@example.invalid',
      metadata: { password: 'sensitive-value' },
    },
  ]);
  const generalAudit = vi.fn(async () => ({ events: [] }));
  async function setup(role: PlatformRole | null = 'TECHNICAL_ADMIN') {
    const auth = new FakeAuthStore();
    roles = new FakePlatformRoleStore();
    audit = new FakeAuditStore();
    auth.users.push(aUser({ id: 'technical-user' }));
    auth.terms.push({ userId: 'technical-user', termsVersion: 'test-terms' });
    await auth.createSession({
      id: randomUUID(),
      userId: 'technical-user',
      tokenHash: hashToken('technical-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600_000),
      userAgentHash: null,
      ipPrefix: null,
    });
    if (role) roles.grant('technical-user', role);
    const module = await Test.createTestingModule({
      controllers: [
        TechnicalController,
        AuditController,
        BillingController,
        BillingAdminController,
        PlatformAdminController,
      ],
      providers: [
        TechnicalService,
        SessionGuard,
        PlatformGuard,
        OrganizationGuard,
        CsrfGuard,
        TechnicalRateLimitGuard,
        AuditRateLimitGuard,
        { provide: AUTH_STORE, useValue: auth },
        { provide: PLATFORM_ROLE_STORE, useValue: roles },
        { provide: ORGANIZATION_STORE, useValue: new FakeOrganizationStore() },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: TERMS_VERSION, useValue: 'test-terms' },
        { provide: RATE_LIMITER, useValue: { consume: async () => ({ allowed: true }) } },
        { provide: TECHNICAL_STORE, useValue: { platformAuditEvents } },
        {
          provide: HealthService,
          useValue: {
            check: async () => ({
              status: 'ok',
              service: 'test-api',
              version: 'test',
              environment: 'test',
              uptimeSeconds: 1,
              dependencies: { postgres: { status: 'up' } },
              timestamp: '2026-11-12T00:00:00Z',
            }),
          },
        },
        {
          provide: AuditService,
          useValue: { auditTrail: generalAudit, operatorContext: () => ({}), overview: () => ({}) },
        },
        { provide: BillingService, useValue: {} },
        { provide: BillingAdminService, useValue: {} },
        { provide: PlatformAdminService, useValue: {} },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });
  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('cookie', 'tv_session=technical-session');

  it('requires a valid session and rechecks the current role', async () => {
    await setup();
    expect((await request(app.getHttpServer()).get('/platform/technical/overview')).status).toBe(
      401,
    );
    expect((await get('/platform/technical/me')).body.platformRole).toBe('TECHNICAL_ADMIN');
    roles.grant('technical-user', 'SUPPORT_ADMIN');
    expect((await get('/platform/technical/overview')).status).toBe(403);
  }, 15_000);
  it.each(['overview', 'providers', 'queues', 'logs'] as const)(
    'permits and audits %s without inventing integration data',
    async (section) => {
      await setup();
      const response = await get(`/platform/technical/${section}`);
      expect(response.status).toBe(200);
      expect(audit.identityEvents.at(-1)?.action).toBe(`platform.technical.${section}_viewed`);
      if (section === 'queues')
        expect(response.body).toMatchObject({ status: 'not_integrated', failedJobs: [] });
      if (section === 'logs')
        expect(response.body).toMatchObject({ status: 'not_configured', entries: [] });
    },
  );
  it('returns exactly the approved diagnostic fields and enforces platform-only scope', async () => {
    await setup();
    const response = await get('/platform/technical/audit');
    expect(response.status).toBe(200);
    expect(Object.keys(response.body.events[0]).sort()).toEqual([
      'action',
      'id',
      'occurredAt',
      'outcome',
      'scope',
      'trail',
    ]);
    expect(platformAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ platformOperationsOnly: true, limit: 51 }),
    );
    expect(JSON.stringify(response.body)).not.toMatch(/private|sensitive-value|customer-id/);
    expect((await get('/platform/technical/audit?action=auth.sign_in.succeeded')).status).toBe(403);
  });
  it('denies the alternate general audit API before its service runs', async () => {
    await setup();
    for (const path of ['me', 'overview', 'audit', 'organizations'])
      expect((await get(`/platform/audit/${path}`)).status).toBe(403);
    expect(generalAudit).not.toHaveBeenCalled();
    expect(audit.actions()).toContain('platform.access.denied');
  });
  it.each(['PLATFORM_OWNER', 'SUPPORT_ADMIN', 'AUDITOR'] as const)(
    'preserves %s access to the general audit API',
    async (role) => {
      await setup(role);
      expect((await get('/platform/audit/audit')).status).toBe(200);
      expect(generalAudit).toHaveBeenCalled();
      expect((await get('/platform/technical/audit')).body.events[0].actor.email).toBe(
        'private@example.invalid',
      );
    },
  );
  it.each(['OPERATIONS_ADMIN', 'SUPPORT_ADMIN', 'AUDITOR', 'BILLING_ADMIN', null] as const)(
    'refuses technical diagnostics to %s',
    async (role) => {
      await setup(role);
      for (const section of ['overview', 'providers', 'queues', 'logs'])
        expect((await get(`/platform/technical/${section}`)).status).toBe(403);
    },
  );
  it('denies financial reads, customer writes and role changes with valid CSRF', async () => {
    await setup();
    for (const path of [
      '/platform/billing/overview',
      '/platform/admin/roles',
      '/organizations/tenant-a/wallet',
      '/organizations/tenant-b/billing',
    ])
      expect((await get(path)).status).toBe(403);
    for (const path of [
      '/platform/admin/roles',
      '/platform/admin/roles/other-user/revoke',
      '/platform/billing/organizations/tenant-a/wallet/adjustments',
      '/organizations/tenant-b/wallet/top-ups',
    ]) {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('cookie', `tv_session=technical-session; tv_csrf=${'c'.repeat(64)}`)
        .set('x-truevine-csrf', 'c'.repeat(64))
        .send({});
      expect(response.status).toBe(403);
    }
  });
  it('fails closed if recording a diagnostic read fails', async () => {
    await setup();
    vi.spyOn(audit, 'recordIdentity').mockRejectedValue(new Error('audit unavailable'));
    expect((await get('/platform/technical/providers')).status).toBe(500);
  });
  it('exposes no technical mutation route even with valid CSRF', async () => {
    await setup();
    expect(
      (
        await request(app.getHttpServer())
          .post('/platform/technical/queues')
          .set('cookie', 'tv_session=technical-session')
      ).status,
    ).toBe(404);
  });
});
