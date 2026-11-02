import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { hashToken, PLATFORM_ROLES, type PlatformRole } from '@truevine/auth';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { AesPaymentCredentialCipher } from '../src/payments/credential-cipher.js';
import { PaymentProvidersController } from '../src/payments/payment-providers.controller.js';
import { PaymentProvidersService } from '../src/payments/payment-providers.service.js';
import { PAYMENT_CREDENTIAL_CIPHER, PAYMENT_PROVIDER_STORE } from '../src/payments/tokens.js';
import {
  FakeAuditStore,
  FakeAuthStore,
  FakeOrganizationStore,
  FakePlatformRoleStore,
  aMembership,
  aUser,
} from './fakes/auth.fakes.js';
import { FakePaymentProviderStore } from './fakes/payment-providers.fakes.js';

const KEY = Buffer.alloc(32, 11).toString('base64');
const MTN = { subscriptionKey: 'http-subscription', apiUser: 'http-user', apiKey: 'http-secret' };
const CALLBACK = 'https://voice.example.test/webhooks/mtn';

/** Real HTTP, session/platform/CSRF guards and service; persistence and crypto are explicit fakes. */
describe('payment-provider configuration HTTP journey', () => {
  let app: INestApplication;
  let auth: FakeAuthStore;
  let organizations: FakeOrganizationStore;
  let platformRoles: FakePlatformRoleStore;
  let store: FakePaymentProviderStore;
  let audit: FakeAuditStore;
  const csrf = 'c'.repeat(64);

  beforeEach(async () => {
    auth = new FakeAuthStore();
    organizations = new FakeOrganizationStore();
    platformRoles = new FakePlatformRoleStore();
    store = new FakePaymentProviderStore();
    audit = new FakeAuditStore();

    auth.users.push(aUser({ id: 'owner-1' }));
    await auth.createSession({
      id: randomUUID(),
      userId: 'owner-1',
      tokenHash: hashToken('payments-session'),
      previousTokenHash: null,
      expiresAt: new Date(Date.now() + 600_000),
      userAgentHash: null,
      ipPrefix: null,
    });
    platformRoles.grant('owner-1', 'PLATFORM_OWNER');

    const module = await Test.createTestingModule({
      controllers: [PaymentProvidersController],
      providers: [
        PaymentProvidersService,
        SessionGuard,
        PlatformGuard,
        CsrfGuard,
        { provide: PAYMENT_PROVIDER_STORE, useValue: store },
        { provide: PAYMENT_CREDENTIAL_CIPHER, useValue: new AesPaymentCredentialCipher(KEY) },
        { provide: AUTH_STORE, useValue: auth },
        { provide: ORGANIZATION_STORE, useValue: organizations },
        { provide: AUDIT_STORE, useValue: audit },
        { provide: PLATFORM_ROLE_STORE, useValue: platformRoles },
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

  function call(method: 'get' | 'put', path: string, withCsrf = true) {
    const client = request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=payments-session; tv_csrf=${csrf}`);
    return withCsrf ? client.set('x-truevine-csrf', csrf) : client;
  }

  const configPath = '/platform/payments/providers/MTN_MOMO/environments/SANDBOX';

  it('lets a platform owner read redacted provider metadata', async () => {
    const response = await call('get', '/platform/payments/providers');

    expect(response.status).toBe(200);
    expect(response.body.providers.map((entry: { provider: string }) => entry.provider)).toEqual([
      'MTN_MOMO',
      'AIRTEL_MONEY',
    ]);
    expect(response.body.providers[0].environments).toHaveLength(2);
    expect(response.body.connectionTesting).toMatchObject({
      available: false,
      code: 'not_available',
    });
    expect(audit.identityEvents.map((event) => event.action)).toContain(
      'platform.payment_provider.configurations_viewed',
    );
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await request(app.getHttpServer())
      .get('/platform/payments/providers')
      .set('cookie', 'tv_session=unknown');

    expect(response.status).toBe(401);
    expect(store.rows).toEqual([]);
  });

  it('refuses a tenant owner with no platform role', async () => {
    platformRoles.setAssignment({
      userId: 'owner-1',
      role: 'PLATFORM_OWNER',
      revokedAt: new Date(),
    });
    organizations.memberships.push(
      aMembership({ organizationId: 'org-1', userId: 'owner-1', role: 'OWNER' }),
    );

    expect((await call('get', '/platform/payments/providers')).status).toBe(403);
    expect(
      (await call('put', configPath).send({ credentials: MTN, callbackUrl: CALLBACK })).status,
    ).toBe(403);
    expect(store.rows).toEqual([]);
  });

  it.each<PlatformRole>(PLATFORM_ROLES.filter((role) => role !== 'PLATFORM_OWNER'))(
    'refuses %s, who holds no payment permission',
    async (role) => {
      platformRoles.grant('owner-1', role);

      const read = await call('get', '/platform/payments/providers');
      const write = await call('put', configPath).send({
        credentials: MTN,
        callbackUrl: CALLBACK,
      });
      const activation = await call('put', `${configPath}/activation`).send({ active: true });

      expect(read.status).toBe(403);
      expect(write.status).toBe(403);
      expect(activation.status).toBe(403);
      expect(store.rows).toEqual([]);
      expect(audit.identityEvents.map((event) => event.action)).toContain('platform.access.denied');
    },
  );

  it('requires a matching CSRF token on configuration writes', async () => {
    const response = await call('put', configPath, false).send({
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('csrf_token_invalid');
    expect(store.rows).toEqual([]);
  });

  it('saves encrypted credentials, activates deliberately, and never echoes a secret', async () => {
    const saved = await call('put', configPath).send({
      credentials: MTN,
      callbackUrl: CALLBACK,
    });

    expect(saved.status).toBe(200);
    expect(saved.body.configuration).toMatchObject({
      provider: 'MTN_MOMO',
      environment: 'SANDBOX',
      status: 'CONFIGURED',
      active: false,
      credentialsPresent: true,
    });
    const serialized = JSON.stringify(saved.body);
    expect(serialized).not.toContain('http-subscription');
    expect(serialized).not.toContain('http-user');
    expect(serialized).not.toContain('http-secret');

    const stored = store.rows[0]!;
    expect(stored.active).toBe(false);
    expect(stored.credentialsCiphertext).not.toContain('http-secret');
    expect(
      new AesPaymentCredentialCipher(KEY).decrypt(
        'MTN_MOMO',
        'SANDBOX',
        stored.credentialsCiphertext!,
      ),
    ).toEqual(MTN);

    const activated = await call('put', `${configPath}/activation`).send({ active: true });
    expect(activated.status).toBe(200);
    expect(activated.body.configuration.status).toBe('ACTIVE');

    const refusedUpdate = await call('put', configPath).send({ credentials: MTN });
    expect(refusedUpdate.status).toBe(409);
    expect(refusedUpdate.body.error.code).toBe('provider_active');

    const deactivated = await call('put', `${configPath}/activation`).send({ active: false });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.configuration).toMatchObject({
      status: 'CONFIGURED',
      active: false,
    });

    expect(store.audits.map((entry) => entry.action)).toEqual([
      'platform.payment_provider.configured',
      'platform.payment_provider.activated',
      'platform.payment_provider.deactivated',
    ]);
    expect(JSON.stringify(store.audits)).not.toContain('http-secret');
  });

  it('rejects invalid providers, environments, callbacks and unknown fields', async () => {
    const cases = [
      '/platform/payments/providers/STRIPE/environments/SANDBOX',
      '/platform/payments/providers/MTN_MOMO/environments/STAGING',
    ];
    for (const path of cases) {
      const response = await call('put', path).send({ credentials: MTN });
      expect(response.status).toBe(400);
    }

    const badCallback = await call('put', configPath).send({
      credentials: MTN,
      callbackUrl: 'http://voice.example.test/webhooks/mtn',
    });
    expect(badCallback.status).toBe(400);
    expect(badCallback.body.error.code).toBe('invalid_callback_url');

    const unknownField = await call('put', configPath).send({ credentials: { surprise: 'x' } });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error.code).toBe('invalid_credentials');

    expect(store.rows).toEqual([]);
  });

  it('keeps environments separate over HTTP', async () => {
    await call('put', configPath).send({ credentials: MTN, callbackUrl: CALLBACK });
    const production = await call(
      'get',
      '/platform/payments/providers/MTN_MOMO/environments/PRODUCTION',
    );

    expect(production.status).toBe(200);
    expect(production.body.configuration.status).toBe('NOT_CONFIGURED');
    expect(production.body.configuration.credentialsPresent).toBe(false);
  });

  it('has no connection-test route to report a simulated success', async () => {
    const response = await call('get', `${configPath}/test-connection`);
    expect(response.status).toBe(404);
  });
});
