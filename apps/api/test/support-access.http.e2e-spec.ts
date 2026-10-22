import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashToken } from '@truevine/auth';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import { RATE_LIMITER, TERMS_VERSION } from '../src/auth/tokens.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

describe('RBAC-014 controlled support access HTTP security', () => {
  let db: PrismaClient;
  let app: INestApplication;
  const operator = randomUUID();
  const customer = randomUUID();
  const platformOwner = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const tokens = new Map<string, string>();
  const csrf = 'rbac014-synthetic-csrf';
  type Verb = 'get' | 'post';

  function http(user: string, method: Verb, path: string, body?: unknown) {
    const req = request(app.getHttpServer())
      [method](path)
      .set('cookie', `tv_session=${tokens.get(user)}; tv_csrf=${csrf}`);
    if (method === 'post') req.set('x-truevine-csrf', csrf);
    return body === undefined ? req : req.send(body as object);
  }

  beforeAll(async () => {
    loadEnvFiles();
    const url = requireEnv('DATABASE_URL');
    const expected = assertDisposableDatabase(url, process.env['NODE_ENV']);
    if (process.env['CI'] !== 'true' && process.env['SUPPORT_ACCESS_DISPOSABLE'] !== '1')
      throw new Error('Set SUPPORT_ACCESS_DISPOSABLE=1 only for a disposable local database.');
    db = createDatabaseClient(url, { log: [] });
    await assertConnectedToDisposableDatabase(
      async () =>
        (await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`)[0]?.name,
      expected,
    );
    await db.$transaction(async (tx) => {
      for (const id of [operator, customer, platformOwner])
        await tx.user.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: 'synthetic' },
        });
      await tx.organization.createMany({
        data: [
          { id: orgA, slug: orgA, name: 'Private diagnostic tenant A' },
          { id: orgB, slug: orgB, name: 'Private diagnostic tenant B' },
        ],
      });
      await tx.membership.createMany({
        data: [
          { organizationId: orgA, userId: customer, role: 'OWNER' },
          { organizationId: orgA, userId: operator, role: 'ADMIN' },
        ],
      });
      await tx.platformRoleAssignment.createMany({
        data: [
          { userId: operator, role: 'SUPPORT_ADMIN' },
          { userId: platformOwner, role: 'PLATFORM_OWNER' },
        ],
      });
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        host: '127.0.0.1',
        port: 0,
        environment: 'test',
        version: 'rbac014',
        databaseUrl: url,
        redisUrl: 'redis://127.0.0.1:56379',
        healthTimeoutMs: 50,
        serviceName: 'truevine-voice-api',
      })
      .overrideProvider(DATABASE_CLIENT)
      .useValue(db)
      .overrideProvider(REDIS_CLIENT)
      .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
      .overrideProvider(RATE_LIMITER)
      .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 10000 }) })
      .compile();
    const terms = module.get<string>(TERMS_VERSION);
    for (const userId of [operator, customer, platformOwner]) {
      const token = randomUUID();
      tokens.set(userId, token);
      await db.session.create({
        data: {
          userId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      await db.termsAcceptance.create({ data: { userId, termsVersion: terms } });
    }
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
  });

  async function createAccess(org = orgA) {
    const response = await http(operator, 'post', '/platform/support/sessions', {
      organizationId: org,
      reasonCode: 'CUSTOMER_REQUEST',
    });
    expect(response.status).toBe(201);
    return response.body as {
      supportSessionId: string;
      organizationId: string;
      expiresAt: string;
      supportAccessToken: string;
    };
  }

  it('requires support-admin permission, an explicit reason, and an existing organization', async () => {
    expect(
      (
        await http(customer, 'post', '/platform/support/sessions', {
          organizationId: orgA,
          reasonCode: 'CUSTOMER_REQUEST',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http(platformOwner, 'post', '/platform/support/sessions', {
          organizationId: orgA,
          reasonCode: 'CUSTOMER_REQUEST',
        })
      ).status,
    ).toBe(403);
    expect(
      (await http(operator, 'post', '/platform/support/sessions', { organizationId: orgA })).status,
    ).toBe(400);
    expect(
      (
        await http(operator, 'post', '/platform/support/sessions', {
          organizationId: randomUUID(),
          reasonCode: 'CUSTOMER_REQUEST',
        })
      ).status,
    ).toBe(404);
  });

  it('scopes diagnostics to the capability organization and preserves the real operator in audit', async () => {
    const session = await createAccess();
    expect(Date.parse(session.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics')
      ).status,
    ).toBe(403);
    const response = await http(
      operator,
      'get',
      '/platform/support/organizations/' + orgA + '/diagnostics?organizationId=' + orgB,
    ).set('x-support-access-token', session.supportAccessToken);
    expect(response.status).toBe(200);
    expect(response.body.organization.id).toBe(orgA);
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgB + '/diagnostics').set(
          'x-support-access-token',
          session.supportAccessToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics'))
        .status,
    ).toBe(403);
    expect(
      (await http(customer, 'get', '/platform/support/organizations/' + orgA + '/diagnostics'))
        .status,
    ).toBe(403);
    const event = await db.securityAuditEvent.findFirst({
      where: { organizationId: orgA, action: 'platform.support.context_diagnostics_viewed' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event?.actorUserId).toBe(operator);
    expect(event?.metadata).toMatchObject({
      supportSessionId: session.supportSessionId,
      reasonCode: 'CUSTOMER_REQUEST',
    });
  });

  it('rejects forged, expired, revoked, cross-operator and nested contexts', async () => {
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics').set(
          'x-support-access-token',
          randomUUID() + randomUUID(),
        )
      ).status,
    ).toBe(403);
    const session = await createAccess(orgB);
    expect(
      (
        await http(customer, 'get', '/platform/support/organizations/' + orgA + '/diagnostics').set(
          'x-support-access-token',
          session.supportAccessToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await http(operator, 'post', '/platform/support/sessions', {
          organizationId: orgA,
          reasonCode: 'SECURITY_REVIEW',
        }).set('x-support-access-token', session.supportAccessToken)
      ).status,
    ).toBe(403);
    const row = await db.supportAccessSession.findUnique({
      where: { organizationId_id: { organizationId: orgB, id: session.supportSessionId } },
    });
    expect(row?.tokenHash).toBe(hashToken(session.supportAccessToken));
    await db.supportAccessSession.update({
      where: { organizationId_id: { organizationId: orgB, id: session.supportSessionId } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics').set(
          'x-support-access-token',
          session.supportAccessToken,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await db.supportAccessSession.findUnique({
          where: { organizationId_id: { organizationId: orgB, id: session.supportSessionId } },
        })
      )?.revokedAt,
    ).not.toBeNull();
  });

  it('terminates immediately and revokes a context when support permission is removed', async () => {
    const session = await createAccess();
    expect(
      (
        await http(operator, 'post', '/platform/support/sessions/terminate').set(
          'x-support-access-token',
          session.supportAccessToken,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics').set(
          'x-support-access-token',
          session.supportAccessToken,
        )
      ).status,
    ).toBe(403);

    const second = await createAccess();
    await db.platformRoleAssignment.update({
      where: { userId: operator },
      data: { revokedAt: new Date() },
    });
    expect(
      (
        await http(operator, 'get', '/platform/support/organizations/' + orgA + '/diagnostics').set(
          'x-support-access-token',
          second.supportAccessToken,
        )
      ).status,
    ).toBe(403);
    const row = await db.supportAccessSession.findUnique({
      where: { organizationId_id: { organizationId: orgA, id: second.supportSessionId } },
    });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('does not let a support context reach tenant mutation routes', async () => {
    const session = await createAccess();
    const before = await db.campaign.count({ where: { organizationId: orgA } });
    const response = await http(operator, 'post', `/organizations/${orgA}/campaigns`, {
      name: 'Must not be created',
    }).set('x-support-access-token', session.supportAccessToken);
    expect(response.status).toBe(403);
    expect(await db.campaign.count({ where: { organizationId: orgA } })).toBe(before);
  });
});
