import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';

/** Real Prisma/HTTP journey. Run only on an explicitly disposable loopback test database. */
describe('RBAC-004 disposable PostgreSQL journey', () => {
  let database: PrismaClient;
  let app: INestApplication;
  const org = randomUUID(),
    other = randomUUID(),
    owner = randomUUID(),
    billing = randomUUID(),
    foreign = randomUUID();
  const entryId = randomUUID();
  const run = randomUUID();
  const email = `billing-${run}@example.invalid`;
  const password = 'disposable-billing-test-password';
  let cookie: string;
  let csrf: string;
  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    if (
      process.env['NODE_ENV'] !== 'test' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
      (process.env['CI'] !== 'true' && process.env['BILLING_E2E_DISPOSABLE'] !== '1')
    )
      throw new Error(
        'Billing E2E requires a disposable loopback test database; set BILLING_E2E_DISPOSABLE=1 only for infrastructure you may discard.',
      );
    database = createDatabaseClient(url);
    const passwordHash = await hashPassword(password);
    await database.$transaction(async (tx) => {
      await tx.user.createMany({
        data: [
          { id: owner, email: `owner-${run}@example.invalid`, passwordHash },
          { id: billing, email, passwordHash },
          { id: foreign, email: `foreign-${run}@example.invalid`, passwordHash },
        ],
      });
      await tx.organization.createMany({
        data: [
          { id: org, slug: `billing-${run}`, name: 'Billing test organization' },
          { id: other, slug: `billing-b-${run}`, name: 'Other billing tenant' },
        ],
      });
      await tx.membership.createMany({
        data: [
          { organizationId: org, userId: owner, role: 'OWNER' },
          { organizationId: org, userId: billing, role: 'BILLING' },
          { organizationId: other, userId: foreign, role: 'OWNER' },
        ],
      });
      await tx.walletEntry.createMany({
        data: [
          {
            organizationId: org,
            id: entryId,
            amountMinor: 100000n,
            currency: 'UGX',
            reference: `credit-${run}`,
            description: 'Confirmed synthetic credit',
          },
          {
            organizationId: org,
            id: randomUUID(),
            amountMinor: -2500n,
            currency: 'UGX',
            reference: `correction-${run}`,
            description: 'Synthetic compensating entry',
          },
          {
            organizationId: other,
            id: randomUUID(),
            amountMinor: 999999n,
            currency: 'UGX',
            reference: `other-${run}`,
            description: 'Other tenant entry',
          },
        ],
      });
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        host: '127.0.0.1',
        port: 0,
        environment: 'test',
        version: 'billing-test',
        databaseUrl: url,
        redisUrl: 'redis://127.0.0.1:56379',
        healthTimeoutMs: 50,
        serviceName: 'truevine-voice-api',
      })
      .overrideProvider(DATABASE_CLIENT)
      .useValue(database)
      .overrideProvider(REDIS_CLIENT)
      .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
      .overrideProvider(RATE_LIMITER)
      .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) })
      .compile();
    app = module.createNestApplication();
    await app.init();
    const probe = await request(app.getHttpServer()).get('/auth/terms');
    function value(headers: unknown, name: string) {
      const values = Array.isArray(headers) ? headers.map(String) : [String(headers)];
      const part = values.find((item) => item.startsWith(`${name}=`));
      if (!part) throw new Error(`Expected ${name} cookie`);
      return part.split(';')[0]!.slice(name.length + 1);
    }
    csrf = decodeURIComponent(value(probe.headers['set-cookie'], 'tv_csrf'));
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .set('cookie', `tv_csrf=${encodeURIComponent(csrf)}`)
      .set('x-truevine-csrf', csrf)
      .send({ email, password });
    expect(signIn.status).toBe(200);
    cookie = `tv_session=${value(signIn.headers['set-cookie'], 'tv_session')}; tv_csrf=${encodeURIComponent(csrf)}`;
    expect((await call('post', '/auth/terms/accept')).status).toBe(204);
  });
  afterAll(async () => {
    await app?.close();
    await database?.$disconnect();
  });
  function call(method: 'get' | 'post' | 'patch', path: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('cookie', cookie)
      .set('x-truevine-csrf', csrf);
  }
  it('shows the ledger balance/history, saves billing details and safely replays concurrent top-ups', async () => {
    const root = `/organizations/${org}`;
    expect((await call('get', `${root}/wallet`)).body).toEqual({
      amountMinor: '97500',
      currency: 'UGX',
    });
    const history = await call('get', `${root}/wallet/transactions`);
    expect(history.status).toBe(200);
    expect(history.body.entries).toHaveLength(2);
    expect(
      (
        await call('patch', `${root}/billing`).send({
          name: 'Customer',
          email: 'finance@example.invalid',
          address: 'Test Kampala',
        })
      ).status,
    ).toBe(200);
    const body = { amountMinor: '25000', currency: 'UGX', idempotencyKey: randomUUID() };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => call('post', `${root}/wallet/top-ups`).send(body)),
    );
    for (const result of results) {
      expect(result.status).toBe(202);
      expect(result.body.id).toBe(results[0]!.body.id);
    }
    expect(
      await database.topUpRequest.count({
        where: { organizationId: org, idempotencyKey: body.idempotencyKey },
      }),
    ).toBe(1);
    expect(
      (await call('post', `${root}/wallet/top-ups`).send({ ...body, amountMinor: '1' })).status,
    ).toBe(409);
    const details = await call('get', `${root}/billing`);
    expect(details.body.profile.name).toBe('Customer');
    expect(details.body.topUps[0].status).toBe('PENDING');
    expect((await call('get', `${root}/wallet`)).body.amountMinor).toBe('97500');
  });
  it('refuses foreign tenants, campaign launch, and foreign transaction cursors', async () => {
    expect((await call('get', `/organizations/${other}/wallet`)).status).toBe(403);
    expect(
      (
        await call('patch', `/organizations/${org}/campaigns/${randomUUID()}`).send({
          status: 'ACTIVE',
        })
      ).status,
    ).toBe(403);
    const foreignEntry = await database.walletEntry.findFirstOrThrow({
      where: { organizationId: other },
    });
    expect(
      (await call('get', `/organizations/${org}/wallet/transactions?cursor=${foreignEntry.id}`))
        .status,
    ).toBe(404);
  });
  it('enforces ledger immutability, currency and tenant/reference constraints in PostgreSQL', async () => {
    const where = { organizationId_id: { organizationId: org, id: entryId } };
    await expect(
      database.walletEntry.update({ where, data: { amountMinor: 1n } }),
    ).rejects.toThrow();
    await expect(database.walletEntry.delete({ where })).rejects.toThrow(/append-only/);
    await expect(
      database.walletEntry.create({
        data: {
          organizationId: org,
          id: randomUUID(),
          amountMinor: 1n,
          currency: 'USD',
          reference: randomUUID(),
          description: 'Invalid currency',
        },
      }),
    ).rejects.toThrow();
    await expect(
      database.walletEntry.create({
        data: {
          organizationId: randomUUID(),
          id: randomUUID(),
          amountMinor: 1n,
          currency: 'UGX',
          reference: randomUUID(),
          description: 'Missing tenant',
        },
      }),
    ).rejects.toThrow();
    await expect(
      database.walletEntry.create({
        data: {
          organizationId: org,
          id: randomUUID(),
          amountMinor: 1n,
          currency: 'UGX',
          reference: `credit-${run}`,
          description: 'Duplicate settlement',
        },
      }),
    ).rejects.toThrow();
  });
});
