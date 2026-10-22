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
const MEMBER_B = randomUUID();
const SUPPORT_ADMIN = randomUUID();
const BILLING_ADMIN = randomUUID();
const AUDITOR = randomUUID();
const CAMPAIGN = randomUUID();
const EMAIL_OWNER_A = `support-owner-a-${RUN}@example.invalid`;
const EMAIL_OWNER_B = `support-owner-b-${RUN}@example.invalid`;
const EMAIL_MEMBER_B = `support-member-b-${RUN}@example.invalid`;
const EMAIL_SUPPORT = `support-admin-${RUN}@example.invalid`;
const EMAIL_BILLING = `support-billing-${RUN}@example.invalid`;
const EMAIL_AUDITOR = `support-auditor-${RUN}@example.invalid`;

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
    post: (path: string, body: object) =>
      request(server)
        .post(path)
        .set(CSRF_HEADER, csrf)
        .set('cookie', `${cookie}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
        .send(body),
    supportGet: (path: string, token: string) =>
      request(server)
        .get(path)
        .set('cookie', cookie)
        .set('x-support-access-token', token),
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
        (${ORG_A}::uuid, ${`support-a-${RUN}`}, 'Support Tenant Alpha', now()),
        (${ORG_B}::uuid, ${`support-b-${RUN}`}, 'Support Tenant Beta', now())`;
    await tx.$executeRaw`
      UPDATE organizations SET suspended_at = now() WHERE id = ${ORG_B}::uuid`;
    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${OWNER_A}::uuid, ${EMAIL_OWNER_A}, ${passwordHash}, now()),
        (${OWNER_B}::uuid, ${EMAIL_OWNER_B}, ${passwordHash}, now()),
        (${MEMBER_B}::uuid, ${EMAIL_MEMBER_B}, ${passwordHash}, now()),
        (${SUPPORT_ADMIN}::uuid, ${EMAIL_SUPPORT}, ${passwordHash}, now()),
        (${BILLING_ADMIN}::uuid, ${EMAIL_BILLING}, ${passwordHash}, now()),
        (${AUDITOR}::uuid, ${EMAIL_AUDITOR}, ${passwordHash}, now())`;
    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG_A}::uuid, ${OWNER_A}::uuid, 'OWNER', now()),
        (${ORG_B}::uuid, ${OWNER_B}::uuid, 'OWNER', now()),
        (${ORG_B}::uuid, ${MEMBER_B}::uuid, 'VIEWER', now())`;
    await tx.$executeRaw`
      INSERT INTO platform_role_assignments (user_id, role) VALUES
        (${SUPPORT_ADMIN}::uuid, 'SUPPORT_ADMIN'),
        (${BILLING_ADMIN}::uuid, 'BILLING_ADMIN'),
        (${AUDITOR}::uuid, 'AUDITOR')`;
    await tx.$executeRaw`
      INSERT INTO campaigns (organization_id, id, name, status, created_by_user_id, updated_at)
      VALUES (${ORG_A}::uuid, ${CAMPAIGN}::uuid, 'Support diagnostics campaign', 'ACTIVE', ${OWNER_A}::uuid, now())`;
    await tx.$executeRaw`
      INSERT INTO wallet_entries (organization_id, id, amount_minor, currency, reference, description, created_at) VALUES
        (${ORG_A}::uuid, ${randomUUID()}::uuid, 5000, 'UGX', ${`support-credit-${RUN}`}, 'Credit', now()),
        (${ORG_A}::uuid, ${randomUUID()}::uuid, -2000, 'UGX', ${`support-debit-${RUN}`}, 'Debit', now())`;
    await tx.$executeRaw`
      INSERT INTO top_up_requests (organization_id, id, idempotency_key, amount_minor, currency, created_by_user_id, created_at)
      VALUES (${ORG_A}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 10000, 'UGX', ${OWNER_A}::uuid, now())`;
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
    where: { userId: { in: [OWNER_A, OWNER_B, MEMBER_B, SUPPORT_ADMIN, BILLING_ADMIN, AUDITOR] } },
  });
  await database.termsAcceptance.deleteMany({
    where: { userId: { in: [OWNER_A, OWNER_B, MEMBER_B, SUPPORT_ADMIN, BILLING_ADMIN, AUDITOR] } },
  });
  await app?.close();
  await database.$disconnect();
});

describe('RBAC-009 support lookup over real PostgreSQL and HTTP', () => {
  it('lets Support Admin discover its own context and find organizations across tenants', async () => {
    const support = await signIn(EMAIL_SUPPORT);

    const me = await support.get('/platform/support/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ platformRole: 'SUPPORT_ADMIN' });

    const search = await support.get('/platform/support/organizations?q=Support%20Tenant');
    expect(search.status).toBe(200);
    expect(search.body.organizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ORG_A, slug: `support-a-${RUN}`, status: 'ACTIVE' }),
        expect.objectContaining({ id: ORG_B, slug: `support-b-${RUN}`, status: 'SUSPENDED' }),
      ]),
    );
    expect(search.body.nextCursor).toBeNull();

    const suspended = await support.get('/platform/support/organizations?status=SUSPENDED');
    expect(suspended.status).toBe(200);
    expect(suspended.body.organizations).toEqual([
      expect.objectContaining({ id: ORG_B }),
    ]);
  });

  it('returns the organization with its members and records the view on the audit trail', async () => {
    const support = await signIn(EMAIL_SUPPORT);

    const detail = await support.get(`/platform/support/organizations/${ORG_A}`);
    expect(detail.status).toBe(200);
    expect(detail.body.organization).toMatchObject({ id: ORG_A, memberCount: 1, campaignCount: 1 });
    expect(detail.body.members).toEqual([
      expect.objectContaining({ userId: OWNER_A, email: EMAIL_OWNER_A, role: 'OWNER' }),
    ]);

    const audit = await database.securityAuditEvent.findFirst({
      where: {
        organizationId: ORG_A,
        actorUserId: SUPPORT_ADMIN,
        action: 'platform.support.organization_viewed',
      },
    });
    expect(audit).toMatchObject({ scope: 'PLATFORM', outcome: 'SUCCESS', targetType: 'organization' });
  });

  it('never records the searched query string on the identity audit trail', async () => {
    const support = await signIn(EMAIL_SUPPORT);
    const response = await support.get(
      `/platform/support/organizations?q=Support%20Tenant%20Alpha&status=ACTIVE`,
    );
    expect(response.status).toBe(200);

    const events = await database.identityAuditEvent.findMany({
      where: { actorUserId: SUPPORT_ADMIN, action: 'platform.support.organization_searched' },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event.metadata)).not.toContain('Support Tenant Alpha');
    }
  });

  it('gives Support Admin read-only diagnostics and hides them from the Auditor', async () => {
    const support = await signIn(EMAIL_SUPPORT);
    const context = await support.post('/platform/support/sessions', {
      organizationId: ORG_A,
      reasonCode: 'SERVICE_DIAGNOSTIC',
    });
    expect(context.status).toBe(201);

    const diagnostics = await support.supportGet(
      `/platform/support/organizations/${ORG_A}/diagnostics`,
      context.body.supportAccessToken,
    );
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toMatchObject({
      billingProfilePresent: false,
      memberCount: 1,
      campaigns: expect.objectContaining({ total: 1, emergencyStoppedCount: 0 }),
      walletBalances: [
        expect.objectContaining({
          currency: 'UGX',
          amountMinor: '3000',
          entryCount: 2,
        }),
      ],
      topUpRequests: [expect.objectContaining({ currency: 'UGX', requestCount: 1 })],
    });
    expect(diagnostics.body.notAvailable).toContain('voice_calls');

    const auditor = await signIn(EMAIL_AUDITOR);
    const auditorRead = await auditor.get(`/platform/support/organizations/${ORG_A}`);
    expect(auditorRead.status).toBe(200);
    const auditorDiagnostics = await auditor.get(
      `/platform/support/organizations/${ORG_A}/diagnostics`,
    );
    expect(auditorDiagnostics.status).toBe(403);
  });

  it('finds users by email fragment and returns a redacted detail view', async () => {
    const support = await signIn(EMAIL_SUPPORT);
    // OWNER_A must actually hold a session for the summary below to be
    // meaningful; sign them in here rather than relying on another test.
    await signIn(EMAIL_OWNER_A);

    const search = await support.get(`/platform/support/users?q=${encodeURIComponent(EMAIL_OWNER_A)}`);
    expect(search.status).toBe(200);
    expect(search.body.users).toEqual([
      expect.objectContaining({
        id: OWNER_A,
        email: EMAIL_OWNER_A,
        platformRole: null,
        membershipCount: 1,
      }),
    ]);

    const detail = await support.get(`/platform/support/users/${OWNER_A}`);
    expect(detail.status).toBe(200);
    expect(detail.body.user).toMatchObject({
      id: OWNER_A,
      email: EMAIL_OWNER_A,
      status: 'ACTIVE',
      platformRole: null,
    });
    expect(detail.body.user).not.toHaveProperty('passwordHash');
    expect(detail.body.memberships).toEqual([
      expect.objectContaining({ organizationId: ORG_A, role: 'OWNER' }),
    ]);
    expect(detail.body.sessionSummary.active).toBeGreaterThanOrEqual(1);
  });

  it('reads both audit trails through the support routes', async () => {
    const support = await signIn(EMAIL_SUPPORT);

    const organizationTrail = await support.get(
      `/platform/support/organizations/${ORG_A}/audit?action=platform.support.organization_viewed`,
    );
    expect(organizationTrail.status).toBe(200);
    expect(organizationTrail.body.events.length).toBeGreaterThan(0);
    // Newest-first, and more than one operator may have viewed this tenant.
    expect(organizationTrail.body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'platform.support.organization_viewed',
          actor: { userId: SUPPORT_ADMIN, email: EMAIL_SUPPORT },
        }),
      ]),
    );

    const userTrail = await support.get(`/platform/support/users/${OWNER_A}/audit`);
    expect(userTrail.status).toBe(200);
    expect(userTrail.body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'auth.sign_in.succeeded' })]),
    );
  });

  it('refuses customer owners, billing admins, and unauthenticated callers', async () => {
    const owner = await signIn(EMAIL_OWNER_A);
    expect((await owner.get('/platform/support/organizations')).status).toBe(403);
    expect((await owner.get(`/platform/support/organizations/${ORG_A}/diagnostics`)).status).toBe(403);
    expect((await owner.get('/platform/support/me')).status).toBe(403);

    const billing = await signIn(EMAIL_BILLING);
    expect((await billing.get('/platform/support/organizations')).status).toBe(403);
    expect((await billing.get('/platform/support/users?q=support-owner')).status).toBe(403);

    const anonymous = await request(server).get('/platform/support/organizations');
    expect(anonymous.status).toBe(401);
  });

  it('validates search input rather than passing it to the database', async () => {
    const support = await signIn(EMAIL_SUPPORT);

    expect((await support.get('/platform/support/users')).status).toBe(400);
    expect((await support.get('/platform/support/users?q=ab')).status).toBe(400);
    expect((await support.get('/platform/support/users?q=owner%25')).status).toBe(400);
    expect((await support.get('/platform/support/organizations?status=DELETED')).status).toBe(400);
    // Against a real tenant so the unknown-action check is reached; a random id
    // would 404 on existence first, which is correct but not what is asserted.
    expect(
      (await support.get(`/platform/support/organizations/${ORG_A}/audit?action=nope`)).status,
    ).toBe(400);
    expect((await support.get(`/platform/support/organizations/${randomUUID()}`)).status).toBe(404);
    expect((await support.get(`/platform/support/organizations/not-a-uuid`)).status).toBe(400);
  });
});
