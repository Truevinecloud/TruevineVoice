import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, ORGANIZATION_ROLES } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContactsController } from '../src/contacts/contacts.controller.js';
import { ContactsService } from '../src/contacts/contacts.service.js';
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

/** Real HTTP and guards; service orchestration and PostgreSQL contracts have separate suites. */
describe('Contacts HTTP authorization contract', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  const csrf = 'a'.repeat(64);
  const service = {
    listContacts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    createContact: vi.fn().mockResolvedValue({ id: 'synthetic-contact' }),
    updateContact: vi.fn().mockResolvedValue({ id: 'synthetic-contact' }),
    deleteContact: vi.fn().mockResolvedValue({ deleted: true }),
    startImport: vi.fn().mockResolvedValue({ id: 'synthetic-import' }),
    processImportBatch: vi.fn().mockResolvedValue({ nextBatchNumber: 1 }),
    completeImport: vi.fn().mockResolvedValue({ status: 'COMPLETED' }),
    importSummary: vi.fn().mockResolvedValue({ id: 'synthetic-import' }),
    recordVoiceConsent: vi.fn().mockResolvedValue({ id: 'synthetic-contact' }),
    suppressContact: vi.fn().mockResolvedValue({ id: 'synthetic-contact' }),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    auth.users.push(aUser({ id: 'user-1' }));
    await auth.createSession({
      id: randomUUID(),
      userId: 'user-1',
      tokenHash: hashToken('contacts-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600000),
      userAgentHash: null,
      ipPrefix: null,
    });
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    organizations.memberships.push(
      aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'OWNER' }),
    );
    const module = await Test.createTestingModule({
      controllers: [ContactsController],
      providers: [
        SessionGuard,
        OrganizationGuard,
        CsrfGuard,
        { provide: ContactsService, useValue: service },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: AUDIT_STORE, useValue: new FakeAuditStore() },
        { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  function call(method: 'get' | 'post' | 'patch' | 'delete', organization = 'org-1') {
    return request(app.getHttpServer())
      [method](
        `/organizations/${organization}/contacts${['patch', 'delete'].includes(method) ? '/synthetic-contact' : ''}`,
      )
      .set('cookie', `tv_session=contacts-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf);
  }
  const importRoutes = [
    ['post', '/contact-imports', 'startImport'],
    ['post', '/contact-imports/synthetic-import/batches', 'processImportBatch'],
    ['post', '/contact-imports/synthetic-import/complete', 'completeImport'],
    ['get', '/contact-imports/synthetic-import', 'importSummary'],
    ['post', '/contacts/synthetic-contact/voice-consent', 'recordVoiceConsent'],
    ['post', '/contacts/synthetic-contact/suppress', 'suppressContact'],
  ] as const;
  function extra(method: 'get' | 'post', path: string, organization = 'org-1') {
    return request(app.getHttpServer())
      [method]('/organizations/' + organization + path)
      .set('cookie', `tv_session=contacts-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf);
  }
  it.each(importRoutes)(
    'allows Campaign Manager %s %s with path-derived scope',
    async (method, path, operation) => {
      organizations.memberships[0]!.role = 'CAMPAIGN_MANAGER';
      const body = {
        organizationId: 'foreign',
        actorUserId: 'foreign-user',
        csv: 'phone,name\n0772000001,Synthetic',
      };
      const response = await extra(method, path).send(body);
      expect(response.status).toBe(method === 'get' ? 200 : 201);
      const args = service[operation].mock.calls[0]!;
      expect(args[0]).toBe('org-1');
      if (method !== 'get') expect(args[1]).toBe('user-1');
    },
  );
  it.each(importRoutes)(
    'refuses Campaign Manager foreign-tenant %s %s before service access',
    async (method, path) => {
      organizations.memberships[0]!.role = 'CAMPAIGN_MANAGER';
      const response = await extra(method, path, 'foreign').send({ organizationId: 'org-1' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('permission_denied');
      for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    },
  );
  it.each(['BILLING', 'VIEWER'] as const)(
    'denies imports and consent operations for %s',
    async (role) => {
      organizations.memberships[0]!.role = role;
      for (const [method, path] of importRoutes) {
        const response = await extra(method, path).send({});
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('permission_denied');
      }
      for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    },
  );
  it('refuses imports immediately after Campaign Manager membership removal', async () => {
    organizations.memberships[0]!.role = 'CAMPAIGN_MANAGER';
    organizations.memberships.length = 0;
    const response = await extra('post', '/contact-imports').send({});
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
  it.each(ORGANIZATION_ROLES)(
    'enforces list, create, edit and delete policy for %s',
    async (role) => {
      organizations.memberships[0]!.role = role;
      const allowed = ['OWNER', 'ADMIN', 'CAMPAIGN_MANAGER'].includes(role);
      expect((await call('get')).status).toBe(allowed ? 200 : 403);
      expect((await call('post').send({ phone: '0772000001' })).status).toBe(allowed ? 201 : 403);
      expect((await call('patch').send({ name: 'Synthetic contact' })).status).toBe(
        allowed ? 200 : 403,
      );
      expect((await call('patch').send({ phone: '0772000002' })).status).toBe(allowed ? 200 : 403);
      if (allowed)
        expect(service.updateContact).toHaveBeenLastCalledWith(
          'org-1',
          'user-1',
          'synthetic-contact',
          { phone: '0772000002' },
        );
      expect((await call('delete')).status).toBe(allowed ? 200 : 403);
      if (!allowed)
        for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
      else
        expect(service.createContact).toHaveBeenCalledWith('org-1', 'user-1', {
          phone: '0772000001',
        });
    },
  );
  it('refuses foreign tenant IDs before calling any contact operation', async () => {
    for (const method of ['get', 'post', 'patch', 'delete'] as const) {
      expect(
        (await call(method, 'foreign-organization').send({ organizationId: 'org-1' })).status,
      ).toBe(403);
    }
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
  it('requires authentication, CSRF and accepted terms', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .patch('/organizations/org-1/contacts/synthetic-contact')
          .send({ phone: '0772000002' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app.getHttpServer())
          .patch('/organizations/org-1/contacts/synthetic-contact')
          .set('cookie', `tv_session=contacts-session; tv_csrf=${csrf}`)
          .send({ phone: '0772000002' })
      ).status,
    ).toBe(403);
    expect((await request(app.getHttpServer()).get('/organizations/org-1/contacts')).status).toBe(
      401,
    );
    expect(
      (
        await request(app.getHttpServer())
          .delete('/organizations/org-1/contacts/synthetic-contact')
          .set('cookie', `tv_session=contacts-session; tv_csrf=${csrf}`)
      ).status,
    ).toBe(403);
    auth.terms.length = 0;
    expect((await call('patch').send({ phone: '0772000002' })).status).toBe(403);
    expect((await call('get')).status).toBe(403);
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
});
