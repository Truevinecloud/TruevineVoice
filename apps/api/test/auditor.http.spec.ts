import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, type PlatformRole } from '@truevine/auth';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { PlatformGuard } from '../src/auth/organization.guard.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { AUDIT_STORE, AUTH_STORE, ORGANIZATION_STORE, PLATFORM_ROLE_STORE, RATE_LIMITER, TERMS_VERSION } from '../src/auth/tokens.js';
import { AuditController } from '../src/audit/audit.controller.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditRateLimitGuard } from '../src/audit/audit-rate-limit.guard.js';
import { AUDITOR_STORE } from '../src/audit/tokens.js';
import type { AuditorStore } from '../src/audit/audit.store.js';
import { FakeAuditStore, FakeAuthStore, FakeOrganizationStore, FakePlatformRoleStore, aUser } from './fakes/auth.fakes.js';

describe('RBAC-011 Auditor HTTP access', () => {
  let app: INestApplication;
  let audit: FakeAuditStore;
  const countOrganizations = vi.fn(async () => 3);
  async function setup(role: PlatformRole | null) {
    const auth = new FakeAuthStore();
    const roles = new FakePlatformRoleStore();
    audit = new FakeAuditStore();
    auth.users.push(aUser({ id: 'auditor' }));
    await auth.createSession({ id: randomUUID(), userId: 'auditor', tokenHash: hashToken('auditor-session'), previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600_000), userAgentHash: null, ipPrefix: null });
    if (role) roles.grant('auditor', role);
    const store: AuditorStore = {
      countOrganizations, platformRoleCounts: async () => [{ role: 'AUDITOR', count: 1 }],
      organizationSummaries: async () => [], platformAuditEvents: async () => [],
    };
    const module = await Test.createTestingModule({ controllers: [AuditController], providers: [
      AuditService, SessionGuard, PlatformGuard, AuditRateLimitGuard,
      { provide: AUDITOR_STORE, useValue: store }, { provide: AUTH_STORE, useValue: auth },
      { provide: AUDIT_STORE, useValue: audit }, { provide: PLATFORM_ROLE_STORE, useValue: roles },
      { provide: ORGANIZATION_STORE, useValue: new FakeOrganizationStore() },
      { provide: TERMS_VERSION, useValue: '2026-10-01' },
      { provide: RATE_LIMITER, useValue: { consume: async () => ({ allowed: true, remaining: 119, retryAfterMs: 0 }) } },
      { provide: APP_FILTER, useClass: AuthExceptionFilter },
    ] }).compile();
    app = module.createNestApplication(); await app.init();
  }
  afterEach(async () => { await app?.close(); vi.clearAllMocks(); });
  const paths = ['me', 'overview', 'organizations', 'audit'];
  it.each(['AUDITOR', 'PLATFORM_OWNER'] as const)('allows %s to read all auditor views with read auditing', async (role) => {
    await setup(role);
    for (const path of paths) {
      const response = await request(app.getHttpServer()).get(`/platform/audit/${path}`).set('cookie', 'tv_session=auditor-session');
      expect(response.status, path).toBe(200);
    }
    expect(audit.identityEvents.map((event) => event.action)).toEqual([
      'platform.audit.overview_viewed', 'platform.audit.organizations_viewed', 'platform.audit.audit_viewed',
    ]);
  });
  it.each([null, 'OPERATIONS_ADMIN', 'BILLING_ADMIN', 'TECHNICAL_ADMIN'] as const)('refuses %s at the general audit trail before reading data', async (role) => {
    await setup(role);
    const response = await request(app.getHttpServer()).get('/platform/audit/overview').set('cookie', 'tv_session=auditor-session');
    expect(response.status).toBe(403); expect(countOrganizations).not.toHaveBeenCalled();
  });
  it('requires a session for every auditor read', async () => {
    await setup('AUDITOR');
    for (const path of paths) expect((await request(app.getHttpServer()).get(`/platform/audit/${path}`)).status).toBe(401);
    expect(countOrganizations).not.toHaveBeenCalled();
  });
  it('has no mutation route for any auditor view', async () => {
    await setup('AUDITOR');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      for (const path of paths) {
        const response = await request(app.getHttpServer())[method](`/platform/audit/${path}`).set('cookie', 'tv_session=auditor-session');
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(countOrganizations).not.toHaveBeenCalled();
  });
});
