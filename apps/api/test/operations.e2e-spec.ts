import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import {
  assertConnectedToDisposableDatabase,
  assertDisposableDatabase,
} from './disposable-database.js';

const TEST_CONFIG: ApiConfig = Object.freeze({
  host: '127.0.0.1',
  port: 0,
  environment: 'test',
  version: '0.1.0-test',
  databaseUrl: 'postgresql://stub/stub',
  redisUrl: 'redis://stub:6379',
  healthTimeoutMs: 50,
  serviceName: 'truevine-voice-api',
});
const PASSWORD = 'a-long-enough-passphrase';
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const MANAGER_B = randomUUID();
const OPERATIONS_ADMIN = randomUUID();
const BILLING_ADMIN = randomUUID();
const CAMPAIGN = randomUUID();
const EMAIL_OWNER_A = `ops-owner-a-${RUN}@example.invalid`;
const EMAIL_OWNER_B = `ops-owner-b-${RUN}@example.invalid`;
const EMAIL_MANAGER_B = `ops-manager-b-${RUN}@example.invalid`;
const EMAIL_OPERATIONS = `ops-admin-${RUN}@example.invalid`;
const EMAIL_BILLING = `ops-billing-${RUN}@example.invalid`;

let app: INestApplication;
let database: PrismaClient;
let server: ReturnType<INestApplication['getHttpServer']>;

function extractCookie(header: unknown, name: string): string {
  const values = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
  const match = values.find((value) => value.startsWith(`${name}=`));
  if (!match) throw new Error(`No ${name} cookie in response.`);
  return match.slice(name.length + 1).split(';')[0] ?? '';
}

async function signIn(email: string) {
  const agent = request(server);
  const probe = await agent.get('/auth/terms');
  const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));
  const response = await agent
    .post('/auth/sign-in')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
    .send({ email, password: PASSWORD });
  expect(response.status).toBe(200);
  const session = extractCookie(response.headers['set-cookie'], SESSION_COOKIE);
  const cookie = `${SESSION_COOKIE}=${session}`;
  const accepted = await agent
    .post('/auth/terms/accept')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`);
  expect(accepted.status).toBe(204);
  return {
    get: (path: string) => request(server).get(path).set('cookie', cookie),
    post: (path: string) =>
      request(server)
        .post(path)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
        .set(CSRF_HEADER, csrf),
    patch: (path: string) =>
      request(server)
        .patch(path)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
        .set(CSRF_HEADER, csrf),
    delete: (path: string) =>
      request(server)
        .delete(path)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
        .set(CSRF_HEADER, csrf),
  };
}

beforeAll(async () => {
  loadEnvFiles();
  const databaseUrl = requireEnv('DATABASE_URL');
  const disposable = assertDisposableDatabase(databaseUrl, process.env['NODE_ENV']);
  database = createDatabaseClient(databaseUrl);
  await assertConnectedToDisposableDatabase(async () => {
    const rows = await database.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    return rows[0]?.name;
  }, disposable);
  const passwordHash = await hashPassword(PASSWORD);
  await database.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO organizations (id, slug, name, updated_at) VALUES
        (${ORG_A}::uuid, ${`ops-a-${RUN}`}, 'Operations Tenant A', now()),
        (${ORG_B}::uuid, ${`ops-b-${RUN}`}, 'Operations Tenant B', now())`;
    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${OWNER_A}::uuid, ${EMAIL_OWNER_A}, ${passwordHash}, now()),
        (${OWNER_B}::uuid, ${EMAIL_OWNER_B}, ${passwordHash}, now()),
        (${MANAGER_B}::uuid, ${EMAIL_MANAGER_B}, ${passwordHash}, now()),
        (${OPERATIONS_ADMIN}::uuid, ${EMAIL_OPERATIONS}, ${passwordHash}, now()),
        (${BILLING_ADMIN}::uuid, ${EMAIL_BILLING}, ${passwordHash}, now())`;
    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'OWNER', now()),
        (${ORG_B}::uuid, ${OWNER_B}::uuid, 'OWNER', now()),
        (${ORG_B}::uuid, ${MANAGER_B}::uuid, 'CAMPAIGN_MANAGER', now())`;
    await tx.$executeRaw`
      INSERT INTO platform_role_assignments (user_id, role) VALUES
        (${OPERATIONS_ADMIN}::uuid, 'OPERATIONS_ADMIN'),
        (${BILLING_ADMIN}::uuid, 'BILLING_ADMIN')`;
    await tx.$executeRaw`
      INSERT INTO campaigns (organization_id, id, name, status, created_by_user_id, updated_at)
      VALUES (${ORG_B}::uuid, ${CAMPAIGN}::uuid, 'Emergency stop target', 'ACTIVE', ${OWNER_B}::uuid, now())`;
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .overrideProvider(DATABASE_CLIENT)
    .useValue(database)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    .overrideProvider(RATE_LIMITER)
    .useValue({ consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }) })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  if (!database) return;
  await database.session.deleteMany({
    where: { userId: { in: [OWNER_A, OWNER_B, MANAGER_B, OPERATIONS_ADMIN, BILLING_ADMIN] } },
  });
  await database.termsAcceptance.deleteMany({
    where: { userId: { in: [OWNER_A, OWNER_B, MANAGER_B, OPERATIONS_ADMIN, BILLING_ADMIN] } },
  });
  await app?.close();
  await database.$disconnect();
});

describe('RBAC-007 platform operations over real PostgreSQL and HTTP', () => {
  it('allows Operations Admin to inspect organizations and campaigns across tenants', async () => {
    const operator = await signIn(EMAIL_OPERATIONS);
    const organizations = await operator.get('/platform/operations/organizations');
    const campaigns = await operator.get('/platform/operations/campaigns');
    expect(organizations.status).toBe(200);
    expect(organizations.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ORG_A, status: 'ACTIVE' }),
        expect.objectContaining({ id: ORG_B, status: 'ACTIVE' }),
      ]),
    );
    expect(campaigns.status).toBe(200);
    expect(campaigns.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: ORG_B, id: CAMPAIGN, status: 'ACTIVE' }),
      ]),
    );
  });

  it('denies customer owners and Billing Admin emergency-stop permission', async () => {
    const owner = await signIn(EMAIL_OWNER_A);
    const ownerRead = await owner.get('/platform/operations/campaigns');
    expect(ownerRead.status).toBe(403);

    const billing = await signIn(EMAIL_BILLING);
    const stop = await billing
      .post(`/platform/operations/organizations/${ORG_B}/campaigns/${CAMPAIGN}/emergency-stop`)
      .send({ reasonCode: 'provider_incident' });
    expect(stop.status).toBe(403);
    expect(
      await database.campaign.findUnique({
        where: { organizationId_id: { organizationId: ORG_B, id: CAMPAIGN } },
      }),
    ).toMatchObject({ status: 'ACTIVE', emergencyStoppedAt: null });
  });

  it('stops a campaign atomically, audits the operator, and prevents customer reactivation', async () => {
    const operator = await signIn(EMAIL_OPERATIONS);
    const stopped = await operator
      .post(`/platform/operations/organizations/${ORG_B}/campaigns/${CAMPAIGN}/emergency-stop`)
      .send({ reasonCode: 'provider_incident' });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      status: 'PAUSED',
      stopResult: 'stopped',
      voiceDispatchStopped: false,
    });

    const audit = await database.securityAuditEvent.findFirst({
      where: {
        organizationId: ORG_B,
        actorUserId: OPERATIONS_ADMIN,
        action: 'platform.campaign.emergency_stopped',
      },
    });
    expect(audit).toMatchObject({
      scope: 'PLATFORM',
      outcome: 'SUCCESS',
      targetType: 'campaign',
      targetId: CAMPAIGN,
    });
    expect(audit?.metadata).toEqual({
      auditVersion: 1,
      target: { type: 'campaign', id: CAMPAIGN },
      before: { status: 'ACTIVE', emergencyStoppedAt: null },
      change: { status: 'COMPLETED', emergencyStoppedAt: expect.any(String) },
      after: { status: 'COMPLETED', emergencyStoppedAt: expect.any(String) },
      reasonCode: 'provider_incident',
      reasonSource: 'caller',
      justification: null,
      requestId: expect.any(String),
    });

    const manager = await signIn(EMAIL_MANAGER_B);
    const reactivation = await manager
      .patch(`/organizations/${ORG_B}/campaigns/${CAMPAIGN}`)
      .send({ status: 'ACTIVE' });
    expect(reactivation.status).toBe(400);
    const deletion = await manager.delete(`/organizations/${ORG_B}/campaigns/${CAMPAIGN}`);
    expect(deletion.status).toBe(409);
    expect(
      await database.campaign.findUnique({
        where: { organizationId_id: { organizationId: ORG_B, id: CAMPAIGN } },
      }),
    ).toMatchObject({ status: 'COMPLETED', emergencyStoppedAt: expect.any(Date) });
    await expect(
      database.campaign.update({
        where: { organizationId_id: { organizationId: ORG_B, id: CAMPAIGN } },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/Emergency-stopped campaign cannot be restarted/);
  });

  it('does not disclose or stop a campaign when a platform operator supplies the wrong tenant path', async () => {
    const operator = await signIn(EMAIL_OPERATIONS);
    const response = await operator
      .post(`/platform/operations/organizations/${ORG_A}/campaigns/${CAMPAIGN}/emergency-stop`)
      .send({ reasonCode: 'provider_incident' });
    expect(response.status).toBe(404);
  });
});
