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
describe('Contact groups HTTP authorization contract', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  const csrf = 'a'.repeat(64);
  const service = {
    listGroups: vi.fn().mockResolvedValue([]),
    createGroup: vi.fn().mockResolvedValue({ id: 'group' }),
    getGroup: vi.fn().mockResolvedValue({ id: 'group' }),
    updateGroup: vi.fn().mockResolvedValue({ id: 'group' }),
    deleteGroup: vi.fn().mockResolvedValue({ deleted: true }),
    groupContacts: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    setGroupMembership: vi.fn().mockResolvedValue({ member: true, changed: true }),
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
  const operations = [
    ['get', '', 200],
    ['post', '', 201],
    ['get', '/group', 200],
    ['patch', '/group', 200],
    ['delete', '/group', 200],
    ['get', '/group/contacts', 200],
    ['post', '/group/contacts/contact', 201],
    ['delete', '/group/contacts/contact', 200],
  ] as const;
  function call(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    organization = 'org-1',
    withCsrf = true,
  ) {
    const req = request(app.getHttpServer())
      [method]('/organizations/' + organization + '/contact-groups' + path)
      .set('cookie', 'tv_session=contacts-session; tv_csrf=' + csrf);
    if (withCsrf) req.set('x-truevine-csrf', csrf);
    return req;
  }
  it.each(ORGANIZATION_ROLES)('enforces every group route for %s', async (role) => {
    organizations.memberships[0]!.role = role;
    const allowed = ['OWNER', 'ADMIN', 'CAMPAIGN_MANAGER'].includes(role);
    for (const [method, path, status] of operations)
      expect((await call(method, path).send({ name: 'Group' })).status).toBe(
        allowed ? status : 403,
      );
    if (!allowed)
      for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
    else {
      expect(service.updateGroup).toHaveBeenCalledWith('org-1', 'user-1', 'group', {
        name: 'Group',
      });
      expect(service.setGroupMembership).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'group',
        'contact',
        true,
      );
      expect(service.setGroupMembership).toHaveBeenCalledWith(
        'org-1',
        'user-1',
        'group',
        'contact',
        false,
      );
    }
  });
  it('refuses a foreign organization path on all group routes', async () => {
    for (const [method, path] of operations)
      expect((await call(method, path, 'foreign').send({ organizationId: 'org-1' })).status).toBe(
        403,
      );
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
  it('requires authentication, accepted terms and CSRF for each mutation', async () => {
    for (const [method, path] of operations) {
      expect(
        (await request(app.getHttpServer())[method]('/organizations/org-1/contact-groups' + path))
          .status,
      ).toBe(401);
      if (method !== 'get') expect((await call(method, path, 'org-1', false)).status).toBe(403);
    }
    auth.terms.length = 0;
    for (const [method, path] of operations) expect((await call(method, path)).status).toBe(403);
    for (const operation of Object.values(service)) expect(operation).not.toHaveBeenCalled();
  });
});
