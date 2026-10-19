/**
 * Campaign routes against the real HTTP stack and real PostgreSQL.
 *
 * RBAC-003 acceptance: the CAMPAIGN_MANAGER role reaches campaigns for real,
 * every other role that must not is refused with a 403, and a campaign from one
 * tenant is invisible to another. The unit suite proves the guards and the
 * service; this proves the whole stack, with database constraints doing the
 * work.
 *
 * Requires:
 *   npm run infra:up
 *   npm run test:e2e
 *
 * Every row this suite is able to remove is removed in `afterAll`. Audit rows
 * are append-only and cannot be deleted; the identifiers are unique per run so
 * that costs nothing but rows in a development database.
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword } from '@truevine/auth/passwords';
import { loadEnvFiles, requireEnv } from '@truevine/shared';
import { createDatabaseClient, type PrismaClient } from '@truevine/database';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { APP_CONFIG } from '../src/config/app-config.module.js';
import type { ApiConfig } from '../src/config/api.config.js';
import { DATABASE_CLIENT, REDIS_CLIENT } from '../src/tokens.js';
import { RATE_LIMITER } from '../src/auth/tokens.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/cookies.js';

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

let app: INestApplication;
let database: PrismaClient;

/** The HTTP server supertest drives. Typed, so a wrong argument is a compile error. */
let server: ReturnType<INestApplication['getHttpServer']>;

/**
 * Fixture identifiers, unique per run.
 *
 * `security_audit_events` is append-only, so the users and organizations this
 * suite creates cannot be deleted; unique ids per run mean there is nothing to
 * collide with and nothing left to clean beyond what cascades.
 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 8);
const ORG = randomUUID();
const ORG_B = randomUUID();
const USER_OWNER = randomUUID();
const USER_ADMIN = randomUUID();
const USER_CM = randomUUID();
const USER_BILLING = randomUUID();
const USER_VIEWER = randomUUID();
const USER_FOREIGN = randomUUID();

const EMAIL_OWNER = `e2e-owner-${RUN}@example.invalid`;
const EMAIL_ADMIN = `e2e-admin-${RUN}@example.invalid`;
const EMAIL_CM = `e2e-cm-${RUN}@example.invalid`;
const EMAIL_BILLING = `e2e-billing-${RUN}@example.invalid`;
const EMAIL_VIEWER = `e2e-viewer-${RUN}@example.invalid`;
const EMAIL_FOREIGN = `e2e-foreign-${RUN}@example.invalid`;

/**
 * Deletes the rows this suite is able to delete.
 *
 * Campaigns go: nothing references them (the audit `target_id` is a string,
 * not a foreign key). Sessions and terms acceptances go: no audit reference.
 * Organizations, users, memberships and audit events cannot go - the append-only
 * trigger and the actor foreign key refuse - which is exactly why every id above
 * is unique per run.
 */
async function removeFixtures(client: PrismaClient): Promise<void> {
  const users = [USER_OWNER, USER_ADMIN, USER_CM, USER_BILLING, USER_VIEWER, USER_FOREIGN];

  await client.campaign.deleteMany({ where: { organizationId: { in: [ORG, ORG_B] } } });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.termsAcceptance.deleteMany({ where: { userId: { in: users } } });
}

beforeAll(async () => {
  loadEnvFiles();

  const databaseUrl = requireEnv('DATABASE_URL');
  database = createDatabaseClient(databaseUrl);

  // Clean the fixtures BEFORE creating them, not only afterwards. A suite that
  // fails partway through skips its own teardown, and the next run then collides
  // with whatever the last one left behind.
  await removeFixtures(database);

  await database.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO organizations (id, slug, name, updated_at) VALUES
        (${ORG}::uuid, ${`e2e-camp-${RUN}`}, 'E2E Campaigns Org', now()),
        (${ORG_B}::uuid, ${`e2e-camp-b-${RUN}`}, 'E2E Campaigns Org B', now())
    `;

    const passwordHash = await hashPassword(PASSWORD);

    await tx.$executeRaw`
      INSERT INTO users (id, email, password_hash, updated_at) VALUES
        (${USER_OWNER}::uuid, ${EMAIL_OWNER}, ${passwordHash}, now()),
        (${USER_ADMIN}::uuid, ${EMAIL_ADMIN}, ${passwordHash}, now()),
        (${USER_CM}::uuid, ${EMAIL_CM}, ${passwordHash}, now()),
        (${USER_BILLING}::uuid, ${EMAIL_BILLING}, ${passwordHash}, now()),
        (${USER_VIEWER}::uuid, ${EMAIL_VIEWER}, ${passwordHash}, now()),
        (${USER_FOREIGN}::uuid, ${EMAIL_FOREIGN}, ${passwordHash}, now())
    `;

    await tx.$executeRaw`
      INSERT INTO memberships (organization_id, user_id, role, updated_at) VALUES
        (${ORG}::uuid, ${USER_OWNER}::uuid, 'OWNER', now()),
        (${ORG}::uuid, ${USER_ADMIN}::uuid, 'ADMIN', now()),
        (${ORG}::uuid, ${USER_CM}::uuid, 'CAMPAIGN_MANAGER', now()),
        (${ORG}::uuid, ${USER_BILLING}::uuid, 'BILLING', now()),
        (${ORG}::uuid, ${USER_VIEWER}::uuid, 'VIEWER', now()),
        (${ORG_B}::uuid, ${USER_FOREIGN}::uuid, 'OWNER', now())
    `;
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    // The real Prisma client, so the suite exercises real constraints.
    .overrideProvider(DATABASE_CLIENT)
    .useValue(database)
    .overrideProvider(REDIS_CLIENT)
    .useValue({ ping: async () => 'PONG', disconnect: () => undefined })
    // Rate limiting is replaced deliberately: every request arrives from
    // 127.0.0.1, so the real limiter would correctly refuse after a handful of
    // calls - for a reason unrelated to what this suite tests.
    .overrideProvider(RATE_LIMITER)
    .useValue({
      consume: async () => ({ allowed: true, retryAfterMs: 0, remaining: 1000 }),
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer();
});

afterAll(async () => {
  await app?.close();
  await database?.$disconnect();
});

function extractCookie(header: unknown, name: string): string {
  const values = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
  const match = values.find((value) => value.startsWith(`${name}=`));

  if (!match) throw new Error(`No ${name} cookie in the response.`);

  return match.slice(name.length + 1).split(';')[0] ?? '';
}

/** Signs in, accepts terms, and returns the session cookie plus a CSRF token. */
async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const agent = request(server);

  const probe = await agent.get('/auth/terms');
  const csrf = decodeURIComponent(extractCookie(probe.headers['set-cookie'], CSRF_COOKIE));

  const response = await agent
    .post('/auth/sign-in')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrf)}`)
    .send({ email, password: PASSWORD });

  expect(response.status, `sign-in for ${email}`).toBe(200);

  const session = extractCookie(response.headers['set-cookie'], SESSION_COOKIE);

  const accepted = await agent
    .post('/auth/terms/accept')
    .set(CSRF_HEADER, csrf)
    .set('cookie', `${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`);
  expect(accepted.status).toBe(204);

  return { cookie: `${SESSION_COOKIE}=${session}`, csrf };
}

/** A caller with a session, terms accepted, and a matching CSRF token. */
async function asUser(email: string) {
  const { cookie, csrf } = await signIn(email);
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

const campaignsPath = `/organizations/${ORG}/campaigns`;

/** Creates a campaign as the given user and returns its id. */
async function createCampaign(email: string, name = 'E2E campaign'): Promise<string> {
  const caller = await asUser(email);
  const response = await caller.post(campaignsPath).send({ name });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.id as string;
}

describe('campaign routes: the roles that may manage campaigns', () => {
  // OWNER, ADMIN and CAMPAIGN_MANAGER each hold the full campaign permission
  // set; this walks each of them through the whole lifecycle over HTTP so a
  // regression in any one route is attributed to the role that lost access.
  const allowedRoles = [
    { label: 'OWNER', email: EMAIL_OWNER },
    { label: 'ADMIN', email: EMAIL_ADMIN },
    { label: 'CAMPAIGN_MANAGER', email: EMAIL_CM },
  ] as const;

  for (const { label, email } of allowedRoles) {
    it(`${label} can create, read, update and delete a campaign`, async () => {
      const caller = await asUser(email);

      const created = await caller.post(campaignsPath).send({ name: `By ${label}` });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ name: `By ${label}`, status: 'DRAFT' });

      const list = await caller.get(campaignsPath);
      expect(list.status).toBe(200);
      expect(list.body.some((c: { id: string }) => c.id === created.body.id)).toBe(true);

      const fetched = await caller.get(`${campaignsPath}/${created.body.id}`);
      expect(fetched.status).toBe(200);
      expect(fetched.body.id).toBe(created.body.id);

      const updated = await caller
        .patch(`${campaignsPath}/${created.body.id}`)
        .send({ name: `By ${label} renamed`, status: 'ACTIVE' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ name: `By ${label} renamed`, status: 'ACTIVE' });

      const removed = await caller.delete(`${campaignsPath}/${created.body.id}`);
      expect(removed.status).toBe(204);

      const gone = await caller.get(`${campaignsPath}/${created.body.id}`);
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe('campaign_not_found');
    });
  }
});

describe('campaign routes: the roles that must not mutate them', () => {
  it('refuses BILLING every campaign route, including the read', async () => {
    const caller = await asUser(EMAIL_BILLING);

    const list = await caller.get(campaignsPath);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('permission_denied');

    const create = await caller.post(campaignsPath).send({ name: 'By billing' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('permission_denied');

    const patch = await caller.patch(`${campaignsPath}/${randomUUID()}`).send({ name: 'x' });
    expect(patch.status).toBe(403);

    const remove = await caller.delete(`${campaignsPath}/${randomUUID()}`);
    expect(remove.status).toBe(403);
  });

  it('lets VIEWER read campaigns but refuses every mutation', async () => {
    const campaignId = await createCampaign(EMAIL_OWNER, 'Read-only visible');
    const caller = await asUser(EMAIL_VIEWER);

    const list = await caller.get(campaignsPath);
    expect(list.status).toBe(200);
    expect(list.body.some((c: { id: string }) => c.id === campaignId)).toBe(true);
    const report = await caller.get(`/organizations/${ORG}/reports/campaign-status`);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ total: expect.any(Number), draft: expect.any(Number) });

    const create = await caller.post(campaignsPath).send({ name: 'By viewer' });
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('permission_denied');

    const patch = await caller.patch(`${campaignsPath}/${campaignId}`).send({ name: 'x' });
    expect(patch.status).toBe(403);

    const remove = await caller.delete(`${campaignsPath}/${campaignId}`);
    expect(remove.status).toBe(403);

    // The refused patch must not have touched the row.
    const owner = await asUser(EMAIL_OWNER);
    const after = await owner.get(`${campaignsPath}/${campaignId}`);
    expect(after.body.name).toBe('Read-only visible');
  });

  it('refuses Viewer billing, top-up, organization, and membership administration actions', async () => {
    const caller = await asUser(EMAIL_VIEWER);
    const item = `${campaignsPath}/${randomUUID()}`;
    const denied = [
      await caller.get(`/organizations/${ORG}/billing`),
      await caller.get(`/organizations/${ORG}/wallet`),
      await caller.post(`/organizations/${ORG}/wallet/top-ups`).send({
        amountMinor: '1000',
        currency: 'UGX',
        idempotencyKey: randomUUID(),
      }),
      await caller.patch(`/organizations/${ORG}/billing`).send({ name: 'Changed' }),
      await caller.patch(`/organizations/${ORG}`).send({ name: 'Changed' }),
      await caller.post(`/organizations/${ORG}/invitations`).send({
        email: 'new@example.invalid',
        role: 'VIEWER',
      }),
      await caller.patch(`/organizations/${ORG}/members/${USER_ADMIN}`).send({ role: 'VIEWER' }),
      await caller.delete(`/organizations/${ORG}/members/${USER_ADMIN}`),
      await caller.post(campaignsPath).send({ name: 'Forbidden' }),
      await caller.patch(item).send({ status: 'ACTIVE' }),
      await caller.delete(item),
      await caller
        .post(`/organizations/${ORG}/ownership/transfer`)
        .send({ newOwnerId: USER_ADMIN }),
    ];

    expect(denied.map((response) => response.status)).toEqual(
      Array.from({ length: 12 }, () => 403),
    );
    expect(denied.every((response) => response.body.error.code === 'permission_denied')).toBe(true);
  });

  it('keeps Viewer campaign and report reads inside its organization', async () => {
    const caller = await asUser(EMAIL_VIEWER);

    expect((await caller.get(`/organizations/${ORG_B}/campaigns`)).status).toBe(403);
    expect((await caller.get(`/organizations/${ORG_B}/reports/campaign-status`)).status).toBe(403);
  });
});

describe('campaign routes: a Campaign Manager stays inside campaigns', () => {
  // RBAC-003's prohibited-access half, over HTTP. The role reaches campaigns
  // (covered above); it must not reach membership, invitations, ownership,
  // organization settings or another tenant - each refused by the guard, not by
  // a check in a handler.
  it('refuses the member list', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller.get(`/organizations/${ORG}/members`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });

  it('refuses sending an invitation', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller
      .post(`/organizations/${ORG}/invitations`)
      .send({ email: 'somebody@example.invalid', role: 'VIEWER' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });

  it('refuses transferring ownership', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller
      .post(`/organizations/${ORG}/ownership/transfer`)
      .send({ newOwnerId: USER_ADMIN });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });

  it('refuses renaming the organization', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller.patch(`/organizations/${ORG}`).send({ name: 'Hijacked' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });
});

describe('campaign routes: tenant isolation', () => {
  it('refuses a Campaign Manager of one tenant reaching another tenant', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller.get(`/organizations/${ORG_B}/campaigns`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('permission_denied');
  });

  it('answers identically for a campaign path that does not exist', async () => {
    const caller = await asUser(EMAIL_CM);

    const missing = await caller.get(`${campaignsPath}/${randomUUID()}`);
    const foreign = await caller.get(`${campaignsPath}/${await createForeignCampaign()}`);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(missing.body.error.code).toBe('campaign_not_found');
    expect(foreign.body.error.code).toBe('campaign_not_found');
    expect(missing.body.error).toEqual(foreign.body.error);
  });

  it('does not let a campaign of another tenant be updated or deleted', async () => {
    const foreignId = await createForeignCampaign('Untouchable');
    const caller = await asUser(EMAIL_CM);

    const patch = await caller.patch(`${campaignsPath}/${foreignId}`).send({ name: 'Hijacked' });
    expect(patch.status).toBe(404);

    const remove = await caller.delete(`${campaignsPath}/${foreignId}`);
    expect(remove.status).toBe(404);

    // The foreign row is untouched, read through its own tenant.
    const owner = await asUser(EMAIL_FOREIGN);
    const still = await owner.get(`/organizations/${ORG_B}/campaigns/${foreignId}`);
    expect(still.status).toBe(200);
    expect(still.body.name).toBe('Untouchable');
  });

  /** Creates a campaign in ORG_B, owned by its real owner, and returns its id. */
  async function createForeignCampaign(name = 'Foreign campaign'): Promise<string> {
    const foreign = await asUser(EMAIL_FOREIGN);
    const response = await foreign.post(`/organizations/${ORG_B}/campaigns`).send({ name });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.id as string;
  }
});

describe('campaign routes: validation over HTTP', () => {
  it('refuses an empty name with 400 invalid_campaign', async () => {
    const caller = await asUser(EMAIL_CM);

    const response = await caller.post(campaignsPath).send({ name: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_campaign');
  });

  it('refuses an empty patch with 400 rather than pretending to succeed', async () => {
    const campaignId = await createCampaign(EMAIL_CM, 'Patch target');
    const caller = await asUser(EMAIL_CM);

    const response = await caller.patch(`${campaignsPath}/${campaignId}`).send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_campaign');
  });

  it('refuses an unknown status with 400', async () => {
    const campaignId = await createCampaign(EMAIL_CM, 'Status target');
    const caller = await asUser(EMAIL_CM);

    const response = await caller
      .patch(`${campaignsPath}/${campaignId}`)
      .send({ status: 'SOMETHING_ELSE' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_campaign');
  });
});

describe('campaign routes: audit over HTTP', () => {
  it('records a campaign.created success against the organization, by the campaign manager', async () => {
    const before = await database.securityAuditEvent.count({
      where: { organizationId: ORG, action: 'campaign.created', actorUserId: USER_CM },
    });

    await createCampaign(EMAIL_CM, 'Audited campaign');

    const rows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG, action: 'campaign.created', actorUserId: USER_CM },
    });

    expect(rows.length).toBe(before + 1);
    const newest = rows.at(-1);
    expect(newest?.outcome).toBe('SUCCESS');
    expect(newest?.scope).toBe('ORGANIZATION');
    expect(newest?.metadata).toMatchObject({ organizationId: ORG });
  });

  it('records a campaign.updated success', async () => {
    const campaignId = await createCampaign(EMAIL_CM, 'Update audited');
    const caller = await asUser(EMAIL_CM);

    await caller.patch(`${campaignsPath}/${campaignId}`).send({ status: 'ACTIVE' });

    const rows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG, action: 'campaign.updated', actorUserId: USER_CM },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.outcome).toBe('SUCCESS');
  });

  it('records a campaign.deleted success', async () => {
    const campaignId = await createCampaign(EMAIL_CM, 'Delete audited');
    const caller = await asUser(EMAIL_CM);

    await caller.delete(`${campaignsPath}/${campaignId}`);

    const rows = await database.securityAuditEvent.findMany({
      where: { organizationId: ORG, action: 'campaign.deleted', actorUserId: USER_CM },
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.outcome).toBe('SUCCESS');
  });

  it('records BILLINGs refused create as a denial naming the permission', async () => {
    const caller = await asUser(EMAIL_BILLING);

    await caller.post(campaignsPath).send({ name: 'Should be refused' });

    const rows = await database.securityAuditEvent.findMany({
      where: {
        organizationId: ORG,
        action: 'authorization.denied',
        actorUserId: USER_BILLING,
      },
    });

    const campaignDenial = rows.find(
      (row) => (row.metadata as { permission?: string } | null)?.permission === 'campaign:create',
    );

    expect(campaignDenial).toBeDefined();
    expect(campaignDenial?.outcome).toBe('DENIED');
    expect(campaignDenial?.metadata).toMatchObject({
      permission: 'campaign:create',
      reason: 'insufficient_permission',
    });
  });
});

describe('campaign routes: session and CSRF', () => {
  it('refuses every campaign route with no session', async () => {
    const item = `${campaignsPath}/${randomUUID()}`;

    // The routes that exist, with the methods they actually answer. An
    // unmatched method-and-path never reaches the guards - the router
    // answers 404 for a route that does not exist - so POST on a campaign
    // item is deliberately not part of this list.
    const list = await request(server).get(campaignsPath);
    expect(list.status, 'GET list').toBe(401);

    const create = await request(server).post(campaignsPath).send({ name: 'x' });
    expect(create.status, 'POST list').toBe(401);

    const fetched = await request(server).get(item);
    expect(fetched.status, 'GET item').toBe(401);

    const patched = await request(server).patch(item).send({ name: 'x' });
    expect(patched.status, 'PATCH item').toBe(401);

    const removed = await request(server).delete(item);
    expect(removed.status, 'DELETE item').toBe(401);
  });

  it('refuses a create with no CSRF token', async () => {
    const { cookie } = await signIn(EMAIL_CM);

    const response = await request(server)
      .post(campaignsPath)
      .set('cookie', cookie)
      .send({ name: 'No CSRF' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('csrf_token_invalid');
  });
});

describe('campaign teardown', () => {
  it('removed every campaign the suite created', async () => {
    await removeFixtures(database);

    const remaining = await database.campaign.count({
      where: { organizationId: { in: [ORG, ORG_B] } },
    });

    // Campaigns carry no audit foreign key, so they are the one tenant-owned
    // table this suite can and does empty.
    expect(remaining).toBe(0);
  });

  it('removed the sessions and terms acceptances it created', async () => {
    await removeFixtures(database);

    const sessions = await database.session.count({
      where: {
        userId: { in: [USER_OWNER, USER_ADMIN, USER_CM, USER_BILLING, USER_VIEWER, USER_FOREIGN] },
      },
    });
    const terms = await database.termsAcceptance.count({
      where: {
        userId: { in: [USER_OWNER, USER_ADMIN, USER_CM, USER_BILLING, USER_VIEWER, USER_FOREIGN] },
      },
    });

    expect(sessions).toBe(0);
    expect(terms).toBe(0);
  });
});
