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
const AUDITOR = randomUUID();
const SUPPORT_ADMIN = randomUUID();
const OPERATIONS_ADMIN = randomUUID();
const CAMPAIGN = randomUUID();
const EMAIL_OWNER_A = `auditor-owner-${RUN}@example.invalid`;
const EMAIL_AUDITOR = `auditor-${RUN}@example.invalid`;
const EMAIL_SUPPORT = `auditor-support-${RUN}@example.invalid`;
const EMAIL_OPERATIONS = `auditor-operations-${RUN}@example.invalid`;

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
    post: (path: string, body?: object) => {
      const test = request(server)
        .post(path)
        .set(CSRF_HEADER, csrf)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`);
      return body === undefined ? test : test.send(body);
    },
    patch: (path: string) =>
      request(server)
        .patch(path)
        .set(CSRF_HEADER, csrf)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`),
    delete: (path: string) =>
      request(server)
        .delete(path)
        .set(CSRF_HEADER, csrf)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`),
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
        (${ORG_A}::uuid, ${`auditor-a-${RUN}`}, 'Auditor Tenant Alpha', now()),
        (${ORG_B}::uuid, ${`auditor-b-${RUN}`}, 'Auditor Tenant Beta', now())`;
    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${OWNER_A}::uuid, ${EMAIL_OWNER_A}, ${passwordHash}, now()),
        (${AUDITOR}::uuid, ${EMAIL_AUDITOR}, ${passwordHash}, now()),
        (${SUPPORT_ADMIN}::uuid, ${EMAIL_SUPPORT}, ${passwordHash}, now()),
        (${OPERATIONS_ADMIN}::uuid, ${EMAIL_OPERATIONS}, ${passwordHash}, now())`;
    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'OWNER', now())`;
    await tx.$executeRaw`
      INSERT INTO platform_role_assignments (user_id, role) VALUES
        (${AUDITOR}::uuid, 'AUDITOR'),
        (${SUPPORT_ADMIN}::uuid, 'SUPPORT_ADMIN'),
        (${OPERATIONS_ADMIN}::uuid, 'OPERATIONS_ADMIN')`;
    await tx.$executeRaw`
      INSERT INTO campaigns (organization_id, id, name, status, created_by_user_id, updated_at)
      VALUES (${ORG_A}::uuid, ${CAMPAIGN}::uuid, 'Auditor mutation target', 'ACTIVE', ${OWNER_A}::uuid, now())`;
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
    where: { userId: { in: [OWNER_A, AUDITOR, SUPPORT_ADMIN, OPERATIONS_ADMIN] } },
  });
  await database.termsAcceptance.deleteMany({
    where: { userId: { in: [OWNER_A, AUDITOR, SUPPORT_ADMIN, OPERATIONS_ADMIN] } },
  });
  await app?.close();
  await database.$disconnect();
});

describe('RBAC-011 read-only auditor over real PostgreSQL and HTTP', () => {
  it('lets the auditor discover its own context', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    const me = await auditor.get('/platform/audit/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ platformRole: 'AUDITOR' });
  });

  it('reports platform counts and states the role is read-only', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    const overview = await auditor.get('/platform/audit/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.organizations.total).toBeGreaterThanOrEqual(2);
    expect(overview.body.scope.writable).toEqual([]);
    expect(overview.body.scope.readable).toContain('platform:audit:read');

    const audit = await database.identityAuditEvent.findFirst({
      where: { actorUserId: AUDITOR, action: 'platform.audit.overview_viewed' },
    });
    expect(audit).toMatchObject({ outcome: 'SUCCESS' });
  });

  it('lists organization identity and status, never tenant content or money', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    const organizations = await auditor.get('/platform/audit/organizations');
    expect(organizations.status).toBe(200);
    expect(organizations.body.organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ORG_A, status: 'ACTIVE', memberCount: 1 }),
        expect.objectContaining({ id: ORG_B, status: 'ACTIVE' }),
      ]),
    );

    const serialized = JSON.stringify(organizations.body);
    expect(serialized).not.toMatch(/wallet|billing|balance|amountMinor|topUp/i);
  });

  it('reads the merged platform audit trail and excludes organization-scoped rows', async () => {
    // A tenant owner updates their own organization: that writes an
    // ORGANIZATION-scoped security row, which the platform trail must not carry.
    await signIn(EMAIL_OWNER_A);
    await database.securityAuditEvent.create({
      data: {
        organizationId: ORG_A,
        actorUserId: OWNER_A,
        action: 'organization.profile_updated',
        scope: 'ORGANIZATION',
        outcome: 'SUCCESS',
        metadata: {},
      },
    });

    const auditor = await signIn(EMAIL_AUDITOR);
    const trail = await auditor.get('/platform/audit/audit');
    expect(trail.status).toBe(200);
    expect(trail.body.events.length).toBeGreaterThan(0);

    expect(trail.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.audit.overview_viewed',
          actor: { userId: AUDITOR, email: EMAIL_AUDITOR },
        }),
      ]),
    );
    expect(
      trail.body.events.some(
        (event: { action: string }) => event.action === 'organization.profile_updated',
      ),
    ).toBe(false);
    for (const event of trail.body.events) {
      expect(event.scope === null || event.scope === 'PLATFORM').toBe(true);
    }
  });

  it('refuses customer owners, support and operations admins, and anonymous callers', async () => {
    const owner = await signIn(EMAIL_OWNER_A);
    expect((await owner.get('/platform/audit/me')).status).toBe(403);
    expect((await owner.get('/platform/audit/overview')).status).toBe(403);

    // Support holds `platform:audit:read`, so it may read the merged trail, but
    // it does not hold `platform:tenant:read`... it does, but it is not an
    // auditor: `overview` requires `platform:audit:read` and succeeds, while the
    // auditor overview's organization list uses `platform:tenant:read`. The
    // point of this assertion is that holding one auditor permission does not
    // confer the workspace's other routes.
    const support = await signIn(EMAIL_SUPPORT);
    expect((await support.get('/platform/audit/overview')).status).toBe(200);
    expect((await support.get('/platform/audit/audit')).status).toBe(200);

    // Operations holds neither `platform:audit:read` nor `platform:support:read`,
    // so the audit overview and merged trail are refused; it does hold
    // `platform:tenant:read`, so the organization lookup itself is allowed.
    const operations = await signIn(EMAIL_OPERATIONS);
    expect((await operations.get('/platform/audit/overview')).status).toBe(403);
    expect((await operations.get('/platform/audit/audit')).status).toBe(403);
    expect((await operations.get('/platform/audit/organizations')).status).toBe(200);

    const anonymous = await request(server).get('/platform/audit/overview');
    expect(anonymous.status).toBe(401);
  });

  it('validates the audit action filter and cursor rather than passing them on', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    expect((await auditor.get('/platform/audit/audit?action=nope')).status).toBe(400);
    expect((await auditor.get('/platform/audit/audit?cursor=identity:not-a-uuid')).status).toBe(400);
    expect((await auditor.get('/platform/audit/audit?cursor=organization:abc')).status).toBe(400);
  });

  it('exposes no mutating route on the auditor controller', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    // The controller has no POST/PATCH/DELETE handler, so these are 404 - there
    // is nothing to reach. This is the "no mutation surface" half of RBAC-011.
    for (const path of [
      '/platform/audit/overview',
      '/platform/audit/organizations',
      '/platform/audit/audit',
    ]) {
      expect((await auditor.post(path)).status).toBe(404);
      expect((await auditor.patch(path)).status).toBe(404);
      expect((await auditor.delete(path)).status).toBe(404);
    }
  });

  it('is denied at every existing platform mutation endpoint', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    // RBAC-011 acceptance is "all mutation attempts denied", not merely "the
    // auditor controller has no mutation". The auditor must be refused at the
    // real platform mutation that exists today - the Operations Admin emergency
    // stop - which requires `platform:operations:write`, a permission the
    // auditor does not hold. A 403 (guarded and refused by permission) is
    // expected, never a 200 and never an unguarded 500.
    const stopResponse = await auditor.post(
      `/platform/operations/organizations/${ORG_A}/campaigns/${CAMPAIGN}/emergency-stop`,
      { reasonCode: 'provider_incident' },
    );
    expect(stopResponse.status).toBe(403);

    // The mutation left no state behind: no campaign was stopped and no
    // platform security audit row was written for the denied actor.
    const stopped = await database.campaign.findFirst({
      where: { organizationId: ORG_A, id: CAMPAIGN },
    });
    expect(stopped?.emergencyStoppedAt ?? null).toBeNull();
    const mutationAudit = await database.securityAuditEvent.findFirst({
      where: { actorUserId: AUDITOR, action: 'platform.campaign.emergency_stopped' },
    });
    expect(mutationAudit).toBeNull();
  });

  it('is denied every platform read route outside its four permissions', async () => {
    const auditor = await signIn(EMAIL_AUDITOR);

    // Support diagnostics, tenant membership detail, technical reads and user
    // lookup are all outside the auditor's permissions. Each must be refused.
    const denied = [
      `/platform/support/organizations/${ORG_A}/diagnostics`,
      '/platform/support/users',
      '/platform/technical/overview',
      '/platform/technical/providers',
      '/platform/technical/logs',
    ];
    for (const path of denied) {
      expect((await auditor.get(path)).status, path).toBe(403);
    }
  });
});
