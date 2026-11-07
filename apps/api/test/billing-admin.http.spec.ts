import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, type PlatformRole } from '@truevine/auth';
import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { PlatformGuard } from '../src/auth/organization.guard.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import {
  AUDIT_STORE,
  AUTH_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  TERMS_VERSION,
} from '../src/auth/tokens.js';
import { BillingAdminController } from '../src/billing-admin/billing-admin.controller.js';
import { BillingAdminService } from '../src/billing-admin/billing-admin.service.js';
import { BILLING_ADMIN_STORE } from '../src/billing-admin/tokens.js';
import type {
  BillingAdminOrganizationSummary,
  BillingAdminStore,
  BillingAdminWalletEntry,
} from '../src/billing-admin/billing-admin.store.js';
import { AUDITOR_STORE } from '../src/audit/tokens.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aUser,
} from './fakes/auth.fakes.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const CSRF = 'c'.repeat(64);

class FakeBillingAdminStore implements BillingAdminStore {
  organizations: BillingAdminOrganizationSummary[] = [
    {
      id: ORG_ID,
      name: 'Org One',
      slug: 'org-one',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      memberCount: 1,
      campaignCount: 0,
      billingProfilePresent: true,
      walletBalances: [],
      topUpRequests: [],
    },
  ];
  entries = new Map<string, BillingAdminWalletEntry>();
  entryOrganizations = new Map<string, string>();

  async listOrganizations() {
    return this.organizations;
  }
  async findOrganization(id: string) {
    return this.organizations.find((organization) => organization.id === id);
  }
  async walletEntries() {
    return [];
  }
  async topUpRequests() {
    return [];
  }
  async adjustWallet(input: {
    organizationId: string;
    actorUserId: string;
    amountMinor: bigint;
    currency: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const reference = `billing-adjustment:${input.idempotencyKey}`;
    const existing = [...this.entries.values()].find((entry) => entry.reference === reference);
    if (existing) {
      if (
        this.entryOrganizations.get(existing.id) !== input.organizationId ||
        existing.amountMinor !== input.amountMinor ||
        existing.currency !== input.currency ||
        existing.description !== input.reason
      ) {
        throw new ConflictException({ error: { code: 'idempotency_conflict', message: 'Conflict' } });
      }
      return { entry: existing, created: false };
    }
    const entry: BillingAdminWalletEntry = {
      id: randomUUID(),
      amountMinor: input.amountMinor,
      currency: input.currency,
      reference,
      description: input.reason,
      createdAt: new Date(),
    };
    this.entries.set(entry.id, entry);
    this.entryOrganizations.set(entry.id, input.organizationId);
    return { entry, created: true };
  }
}

describe('platform billing admin HTTP adjustments', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let platformRoles: FakePlatformRoleStore;
  let store: FakeBillingAdminStore;
  let audit: FakeAuditStore;

  async function setup(role: PlatformRole | null) {
    auth = new FakeAuthStore();
    const organizations = new FakeOrganizationStore();
    platformRoles = new FakePlatformRoleStore();
    store = new FakeBillingAdminStore();
    audit = new FakeAuditStore();

    auth.users.push(aUser({ id: 'user-1' }));
    await auth.createSession({
      id: randomUUID(),
      userId: 'user-1',
      tokenHash: hashToken('billing-admin-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600_000),
      userAgentHash: null,
      ipPrefix: null,
    });
    if (role) platformRoles.grant('user-1', role);

    const module = await Test.createTestingModule({
      controllers: [BillingAdminController],
      providers: [
        BillingAdminService,
        SessionGuard,
        PlatformGuard,
        CsrfGuard,
        { provide: BILLING_ADMIN_STORE, useValue: store },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: PLATFORM_ROLE_STORE, useValue: platformRoles },
        { provide: TERMS_VERSION, useValue: '2026-10-01' },
        { provide: AUDITOR_STORE, useValue: { platformAuditEvents: async () => [] } },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  function call(method: 'get' | 'post', path: string, withCsrf = true) {
    const client = request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=billing-admin-session; tv_csrf=${CSRF}`);
    return withCsrf ? client.set('x-truevine-csrf', CSRF) : client;
  }

  it('allows a billing admin to record a valid adjustment', async () => {
    await setup('BILLING_ADMIN');
    const key = randomUUID();
    const response = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });

    expect(response.status).toBe(200);
    expect(response.body.created).toBe(true);
    expect(audit.identityEvents.map((event) => event.action)).toContain('platform.billing.wallet_adjusted');
  });

  it('allows a platform owner to record a valid adjustment', async () => {
    await setup('PLATFORM_OWNER');
    const response = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '2500',
      currency: 'UGX',
      reason: 'Reversal',
      idempotencyKey: randomUUID(),
    });

    expect(response.status).toBe(200);
    expect(response.body.entry.amountMinor).toBe('2500');
  });

  it('denies unrelated platform roles', async () => {
    for (const role of ['SUPPORT_ADMIN', 'TECHNICAL_ADMIN', 'AUDITOR'] as PlatformRole[]) {
      await setup(role);
      const response = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
        amountMinor: '1000',
        currency: 'UGX',
        reason: 'Denied',
        idempotencyKey: randomUUID(),
      });
      expect(response.status).toBe(403);
    }
  });

  it('requires a session and CSRF token', async () => {
    await setup('BILLING_ADMIN');
    const unauthenticated = await request(app.getHttpServer())
      .post(`/platform/billing/organizations/${ORG_ID}/wallet/adjustments`)
      .send({ amountMinor: '1000', currency: 'UGX', reason: 'No session', idempotencyKey: randomUUID() });
    expect(unauthenticated.status).toBe(401);

    const noCsrf = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`, false).send({
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'No CSRF',
      idempotencyKey: randomUUID(),
    });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('csrf_token_invalid');
  });

  it('rejects invalid amount, currency, and reason', async () => {
    await setup('BILLING_ADMIN');
    const cases = [
      { amountMinor: '0', currency: 'UGX', reason: 'Zero' },
      { amountMinor: '1.5', currency: 'UGX', reason: 'Fraction' },
      { amountMinor: '1000', currency: 'UG', reason: 'Bad currency' },
      { amountMinor: '1000', currency: 'UGX', reason: 'ab' },
    ];
    for (const body of cases) {
      const response = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
        ...body,
        idempotencyKey: randomUUID(),
      });
      expect(response.status).toBe(400);
    }
  });

  it('rejects an unknown organization', async () => {
    await setup('BILLING_ADMIN');
    const response = await call('post', `/platform/billing/organizations/${randomUUID()}/wallet/adjustments`).send({
      amountMinor: '1000',
      currency: 'UGX',
      reason: 'Unknown org',
      idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(404);
  });

  it('returns the original entry for a duplicate idempotency key', async () => {
    await setup('BILLING_ADMIN');
    const key = randomUUID();
    const first = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });
    const second = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.entry.id).toBe(first.body.entry.id);
  });

  it('rejects conflicting reuse of an idempotency key', async () => {
    await setup('BILLING_ADMIN');
    const key = randomUUID();
    await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '5000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });
    const response = await call('post', `/platform/billing/organizations/${ORG_ID}/wallet/adjustments`).send({
      amountMinor: '7000',
      currency: 'UGX',
      reason: 'Correction',
      idempotencyKey: key,
    });
    expect(response.status).toBe(409);
  });
});
