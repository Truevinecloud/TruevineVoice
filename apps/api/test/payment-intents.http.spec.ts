import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentIntentsController } from '../src/payments/payment-intents.controller.js';
import { PaymentIntentsService } from '../src/payments/payment-intents.service.js';
import { PAYMENT_INTENT_STORE } from '../src/payments/payment-intents.tokens.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { OrganizationGuard } from '../src/auth/organization.guard.js';
import { CsrfGuard } from '../src/auth/csrf.guard.js';
import { AuthExceptionFilter } from '../src/auth/auth-exception.filter.js';
import {
  AUTH_STORE,
  ORGANIZATION_STORE,
  PLATFORM_ROLE_STORE,
  AUDIT_STORE,
  TERMS_VERSION,
} from '../src/auth/tokens.js';
import {
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  FakeAuditStore,
  aUser,
  aMembership,
} from './fakes/auth.fakes.js';
import { FakePaymentIntentStore } from './fakes/payment-intents.fakes.js';

describe('Payment intents HTTP', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let store: FakePaymentIntentStore;
  const csrf = 'a'.repeat(64);

  beforeEach(async () => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    store = new FakePaymentIntentStore();
    auth.users.push(aUser({ id: 'user-1' }));
    await auth.createSession({
      id: randomUUID(),
      userId: 'user-1',
      tokenHash: hashToken('pi-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600000),
      userAgentHash: null,
      ipPrefix: null,
    });
    await auth.recordTermsAcceptance('user-1', '2026-10-01');
    organizations.memberships.push(aMembership({ organizationId: 'org-1', userId: 'user-1', role: 'BILLING' }));

    const module = await Test.createTestingModule({
      controllers: [PaymentIntentsController],
      providers: [
        PaymentIntentsService,
        SessionGuard,
        OrganizationGuard,
        CsrfGuard,
        { provide: PAYMENT_INTENT_STORE, useValue: store },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: PLATFORM_ROLE_STORE, useValue: new FakePlatformRoleStore() },
        { provide: AUDIT_STORE, useValue: new FakeAuditStore() },
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

  function call(method: 'post' | 'get', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=pi-session; tv_csrf=${csrf}`)
      .set('x-truevine-csrf', csrf);
  }

  it('creates a pending intent and replays identical key', async () => {
    const key = randomUUID();
    const body = { purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: key };
    const first = await call('post', '/organizations/org-1/payments/intents').send(body);
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PENDING');
    const second = await call('post', '/organizations/org-1/payments/intents').send(body);
    expect(second.body.id).toBe(first.body.id);
  });

  it('returns 409 on conflicting retry', async () => {
    const key = randomUUID();
    await call('post', '/organizations/org-1/payments/intents').send({ purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: key });
    const conflict = await call('post', '/organizations/org-1/payments/intents').send({ purpose: 'WALLET_TOP_UP', amountMinor: '6000', currency: 'UGX', idempotencyKey: key });
    expect(conflict.status).toBe(409);
  });

  it('rejects invalid amount/currency/purpose', async () => {
    const base = { purpose: 'WALLET_TOP_UP', currency: 'UGX', idempotencyKey: randomUUID() };
    expect((await call('post', '/organizations/org-1/payments/intents').send({ ...base, amountMinor: '0' })).status).toBe(400);
    expect((await call('post', '/organizations/org-1/payments/intents').send({ ...base, amountMinor: '5000', currency: 'USD' })).status).toBe(400);
    expect((await call('post', '/organizations/org-1/payments/intents').send({ purpose: 'SUBSCRIPTION_RENEWAL', amountMinor: '5000', currency: 'UGX', idempotencyKey: randomUUID() })).status).toBe(400);
  });

  it('denies creation for roles without billing:update', async () => {
    organizations.memberships[0]!.role = 'VIEWER';
    const res = await call('post', '/organizations/org-1/payments/intents').send({ purpose: 'WALLET_TOP_UP', amountMinor: '5000', currency: 'UGX', idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
  });
});
